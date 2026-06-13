// observability — the error.* / log.* / metric.* verbs are wired through the command bus
// and return well-formed shapes. The self-instrument path (handler throws → ErrorTracker →
// error.list) is exercised by the runner's backstop on every test; here we assert the verb
// surface itself is live (the bus-native query side of the observability story).
// log.tail returns STRUCTURED ring entries {ts,level,scope,msg} (attrs/page may ride along).

const READ = `(async()=>{const ex=(c)=>window.__glyphClient.router.execute(c);const el=await ex("error.list");const es=await ex("error.stats");const ml=await ex("metric.list");const lt=await ex("log.tail 10");const ll=await ex("log.level info");const ents=(lt&&lt.data&&lt.data.entries)||null;const shaped=Array.isArray(ents)&&ents.every((e)=>typeof e.ts==="number"&&typeof e.level==="string"&&typeof e.msg==="string"&&"scope" in e);return{errList:Array.isArray(el&&el.data&&el.data.errors),errStats:typeof (es&&es.data&&es.data.total)==="number",metricsOk:Array.isArray(ml&&ml.data&&ml.data.metrics),logOk:Array.isArray(ents),logCount:Array.isArray(ents)?ents.length:0,logShape:shaped,logLevelOk:/OK/.test((ll&&ll.text)||"")};})()`;

export default async ({ app, assert }) => {
  assert.ok(app.booted, 'booted');
  const r = await app.evalPage(READ);
  assert.ok(r.errList, 'error.list returns a data.errors array');
  assert.ok(r.errStats, 'error.stats returns a numeric total');
  assert.ok(r.metricsOk, 'metric.list returns a data.metrics array');
  assert.ok(r.logOk, 'log.tail returns a data.entries array');
  assert.atLeast(r.logCount, 1, 'ring is non-empty after boot (shape check has teeth)');
  assert.ok(r.logShape, 'every entry is structured {ts:number, level:string, scope, msg:string}');
  assert.ok(r.logLevelOk, 'log.level sets verbosity (OK)');
  assert.noErrors(app);
};
