/** @import { AppContext } from './CommandProvider.jsx' */

import { ScrollDocument, wrapCells } from '@glyph3d/core/collections';
import { callerHue } from './Deixis.js';
import { getSetting } from './settings.js';

/**
 * TeamChannels — a team's CHANNEL: every message that crossed between the team's agents and the
 * person, as ONE scroll document pinned at the team's desk.
 *
 * A TEAM is a gomuxai hub agent and the agents under it (GomuxHub's tree: its `parent` links). Its
 * messages are the PROMPT records the members' books already parsed (AgentBooks: the window and its
 * older / newer buffers — no second read) whose origin says someone sent them: another agent
 * (`peer`, a held `delivered` message) or the person (`human`, `queued`). Each is a block: a header
 * row `from → to · HH:MM:SS` in the sender's hue (Deixis.callerHue — the hue its points draw in),
 * then the message's text, indented, wrapped by the layout's own cell rule (wrapCells) — shown as
 * written (nothing dropped: a `[from NAME@HOST]` prefix stays). The recipient is the book's agent;
 * the sender is the text's `[from NAME@HOST]` prefix when it carries one, else the person for a
 * typed prompt, else (a subagent's task) the recipient's parent.
 *
 * Merged by time (then by event id). New messages later than the last shown are TAIL-APPENDED
 * (ScrollDocument.pushBlocks — only their rows are laid out); one that lands out of order re-lays
 * the document (the view stays on what it showed). The channel is a member of the team's desk
 * (`gomux/<team>`, Holding — its residence), registered `channel:<team>`; a session saves which
 * channels are shown and where each was held (`serialize`), and `restore` stands them back up.
 */

/** Prompt origins that are messages (someone sent them). */
const MESSAGE_ORIGINS = new Set(['peer', 'delivered', 'human', 'queued']);
/** The person, as a channel names them. */
export const PERSON = 'you';
/** What may stand before a message's `[from …]` line: a held delivery's preamble, a paste wrapper's open tag. */
const PREAMBLE = String.raw`^(?:\s*(?:A message arrived while you were working:|<pasted_content[^>]*>))*\s*`;
const SENDER = new RegExp(PREAMBLE + String.raw`\[from ([^\]@\s]+)(?:@[^\]\s]+)?\]`);
const PERSON_PREFIX = new RegExp(PREAMBLE + String.raw`\[from a (?:person|Claude session) on [^\]]+\]`);

/** The registry id of a team's channel. @param {string} team */
export const channelId = (team) => `channel:${team}`;

/** The one TeamChannels of an app context (made on first use). @param {AppContext} ctx */
export function teamChannelsOf(ctx) {
    return (ctx.teamChannels ??= new TeamChannels(ctx));
}

/**
 * Who sent a prompt record: its text's `[from NAME@HOST]` prefix, the person for a typed prompt (or a
 * `[from a person on HOST]` prefix), else the recipient's parent (a subagent's task). Pure.
 * @param {{origin?:string, result?:string}} rec @param {string|null} parent
 */
export function senderOf(rec, parent) {
    const text = String(rec.result ?? '');
    if (PERSON_PREFIX.test(text)) return PERSON;
    const m = text.match(SENDER);
    if (m) return m[1];
    if (rec.origin === 'human' || rec.origin === 'queued') return PERSON;
    return parent || 'peer';
}

export default class TeamChannels {
    /** @param {AppContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        /** @type {Map<string, {doc: ScrollDocument, keys: string[]}>} team → its shown channel */
        this.byTeam = new Map();
        this._off = ctx.agentBooks?.onChange?.(() => this.refresh()) ?? null;
    }

    /** A team's members (its agent + every hub agent under it), parents first. @param {string} team */
    members(team) {
        const nodes = this.ctx.gomuxHub?.nodes;
        if (!nodes?.has(team)) return this.ctx.agentBooks?.lanes.has(team) ? [team] : [];
        const out = [team];
        for (let i = 0; i < out.length; i++) for (const [name, a] of nodes) if (a.parent === out[i] && !out.includes(name)) out.push(name);
        return out;
    }

    /**
     * A team's messages, merged by time: `{key, ts, from, to, origin, text}` each — every message
     * prompt the members' books hold (window and buffers), one per event. @param {string} team
     */
    messages(team) {
        const books = this.ctx.agentBooks;
        const nodes = this.ctx.gomuxHub?.nodes;
        const out = [], seen = new Set();
        for (const name of this.members(team)) {
            const lane = books?.lanes.get(name);
            if (!lane) continue;
            const recs = [...(lane.older || []).map((x) => x.record), ...lane.entries.map((e) => e.record), ...(lane.newer || []).map((x) => x.record)];
            for (const rec of recs) {
                if (rec?.action !== 'prompt' || !MESSAGE_ORIGINS.has(rec.origin)) continue;
                const key = `${name}:${rec.id ?? rec.at}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ key, ts: Date.parse(rec.ts) || 0, from: senderOf(rec, nodes?.get(name)?.parent ?? null), to: name, origin: rec.origin, text: String(rec.result ?? '') });
            }
        }
        return out.sort((a, b) => a.ts - b.ts || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    }

    /** A message as its block. @private */
    _block(doc, m) {
        const cols = doc.cfg.cols, ind = 2;
        const hue = this._hue(m.from), toHue = this._hue(m.to), dim = { r: 0.55, g: 0.59, b: 0.66 };
        const time = m.ts ? new Date(m.ts).toISOString().slice(11, 19) : '--:--:--';
        const rows = [{ segs: [{ text: m.from, color: hue }, { text: ' → ', color: dim }, { text: m.to, color: toHue }, { text: ` · ${time}`, color: dim }], indent: 0, src: { part: 'head', line: 0, cont: false } }];
        const lift = { r: hue.r + (1 - hue.r) * 0.6, g: hue.g + (1 - hue.g) * 0.6, b: hue.b + (1 - hue.b) * 0.6 };
        const text = m.text.replace(/\r\n/g, '\n').replace(/\n$/, '');
        text.split('\n').forEach((line, li) => wrapCells(line, Math.max(1, cols - ind), doc.cellsOf, doc.cfg.tabWidth).forEach((r, k) =>
            rows.push({ segs: r ? [{ text: r, color: lift }] : [], indent: ind, src: { part: 'body', line: li, cont: k > 0 } })));
        rows.push({ segs: [], indent: 0, src: { part: 'gap', line: 0, cont: false } });
        return { id: m.key, rows };
    }

    /** @private */
    _hue(who) { return who === PERSON ? { r: 0.92, g: 0.92, b: 0.86 } : callerHue(this.ctx, who); }

    /** The channel's title row. @private */
    _title(team, doc, n) {
        const dim = { r: 0.62, g: 0.66, b: 0.74 };
        return [{ text: `${team} · channel`, color: this._hue(team) }, { text: ` · ${this.members(team).length} member${this.members(team).length === 1 ? '' : 's'} · ${n} message${n === 1 ? '' : 's'} · ${doc.following ? 'live' : 'held'}`, color: dim }];
    }

    /**
     * Stand a team's channel up (or return the shown one): its document, registered `channel:<team>`,
     * seated at the team's desk when it stands. @param {string} team @returns {ScrollDocument|null}
     */
    show(team) {
        const have = this.byTeam.get(team);
        if (have) return have.doc;
        if (!this.members(team).length) return null;
        const doc = new ScrollDocument(this.ctx.atlas, {
            cols: Number(getSetting('channel.cols')), rows: Number(getSetting('channel.rows')),
        });
        doc.name = channelId(team);
        const msgs = this.messages(team);
        doc.setBlocks(msgs.map((m) => this._block(doc, m)));
        doc.setTitle(this._title(team, doc, msgs.length));
        doc.flush();
        this.byTeam.set(team, { doc, keys: msgs.map((m) => m.key) });
        this.ctx.registry?.register?.(channelId(team), doc, { type: 'channel', role: 'channel', team });
        this._seat(team);
        return doc;
    }

    /** Seat a shown channel at its team's desk (when that stands and the channel isn't held). @private */
    _seat(team) {
        const rec = this.byTeam.get(team), desk = this.ctx.carrels?.get(`gomux/${team}`);
        if (!rec || !desk || desk._dissolving || this.ctx.holding?.holderOf(channelId(team))) return;
        this.ctx.holding?.seat({ id: channelId(team), grid: rec.doc }, desk);
    }

    /** Take a team's channel away. @param {string} team @returns {boolean} */
    hide(team) {
        const rec = this.byTeam.get(team);
        if (!rec) return false;
        const id = channelId(team);
        this.ctx.holding?.lift?.(id, { inPlace: true });   // its residence goes with it (a hidden channel doesn't come back)
        this.ctx.registry?.unregister?.(id);
        rec.doc.parent?.remove(rec.doc);
        rec.doc.dispose();
        this.byTeam.delete(team);
        return true;
    }

    /**
     * Bring every shown channel up to its members' books: messages later than the last shown are
     * tail-appended; anything else (one out of order, one gone) re-lays the document, its view kept.
     */
    refresh() {
        for (const [team, rec] of this.byTeam) {
            const msgs = this.messages(team);
            const keys = msgs.map((m) => m.key);
            const doc = rec.doc;
            const prefix = rec.keys.length <= keys.length && rec.keys.every((k, i) => keys[i] === k);
            if (prefix && keys.length === rec.keys.length) { this._seat(team); continue; }
            if (prefix) doc.pushBlocks(msgs.slice(rec.keys.length).map((m) => this._block(doc, m)));
            else {
                const view = doc.view();
                doc.setBlocks(msgs.map((m) => this._block(doc, m)));
                doc.flush();
                if (!doc.setView(view)) doc.follow();
            }
            rec.keys = keys;
            doc.setTitle(this._title(team, doc, msgs.length));
            doc.flush();
            this._seat(team);
        }
    }

    /** Scroll a channel by rows (− up, + down) — the wheel's grammar. */
    scrollRows(team, delta) {
        const rec = this.byTeam.get(team);
        if (!rec) return null;
        const r = rec.doc.scrollBy(delta);
        rec.doc.setTitle(this._title(team, rec.doc, rec.keys.length));
        return r;
    }

    /** What a session keeps: each shown channel and where it was held. */
    serialize() {
        return [...this.byTeam].map(([team, rec]) => ({ team, view: rec.doc.view() }));
    }

    /**
     * Stand saved channels back up once their team is known (the hub's tree, the members' books) —
     * retried every `everyMs` for up to `waitMs` — and put each back on the message it was held at.
     * @param {Array<{team:string, view?:Object}>} list @returns {Promise<number>}
     */
    async restore(list, { waitMs = 60000, everyMs = 2000 } = {}) {
        const one = async ({ team, view }) => {
            const until = Date.now() + waitMs;
            while (Date.now() < until) {
                const doc = this.members(team).some((n) => this.ctx.agentBooks?.lanes.get(n)?.entries.length) ? this.show(team) : null;
                if (doc) {
                    if (view && !view.following) doc.setView(view);
                    return 1;
                }
                await new Promise((r) => setTimeout(r, everyMs));
            }
            console.warn(`[channels] ${team}: its saved channel was not restored — the team never came back`);
            return 0;
        };
        const n = await Promise.all((Array.isArray(list) ? list : []).filter((x) => x && typeof x.team === 'string').map(one));
        return n.reduce((a, b) => a + b, 0);
    }

    dispose() {
        this._off?.();
        for (const team of [...this.byTeam.keys()]) this.hide(team);
    }
}
