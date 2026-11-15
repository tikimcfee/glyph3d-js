//! The termd wire protocol (docs/termd/PROTOCOL.md): the frame codec, the JSON payload
//! types and the terminal-query filter. No I/O and no libghostty, so any client can use it.

pub mod filter;
pub mod frame;
pub mod msg;

pub use filter::QueryFilter;
pub use frame::{Frame, FrameDecoder, FrameError, RepaintHead, ty};
pub use msg::*;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::*;

    /// The hex dumps in PROTOCOL.md's "one session, byte by byte", in order. The spec's
    /// examples are this crate's test vectors.
    fn spec_vectors() -> Vec<Vec<u8>> {
        let spec = include_str!("../../../docs/termd/PROTOCOL.md");
        let mut blocks = Vec::new();
        let mut cur: Option<Vec<u8>> = None;
        for line in spec.lines() {
            if line.starts_with("```") {
                if let Some(b) = cur.take() {
                    if !b.is_empty() {
                        blocks.push(b);
                    }
                } else {
                    cur = Some(Vec::new());
                }
                continue;
            }
            let Some(buf) = cur.as_mut() else { continue };
            // "0000  2e 00 …   ascii": a 4-hex-digit offset, two spaces, up to 16 bytes.
            let bytes = line
                .get(..4)
                .filter(|o| o.chars().all(|c| c.is_ascii_hexdigit()))
                .and_then(|_| line.get(6..).map(|r| r.get(..48).unwrap_or(r)));
            if let Some(hex) = bytes {
                for tok in hex.split_whitespace() {
                    if tok.len() != 2 {
                        break;
                    }
                    match u8::from_str_radix(tok, 16) {
                        Ok(b) => buf.push(b),
                        Err(_) => break,
                    }
                }
            }
        }
        blocks
    }

    fn one_frame(bytes: &[u8]) -> Frame {
        let mut d = FrameDecoder::default();
        // Fed in two pieces: partial reads are the normal case.
        d.feed(&bytes[..5]);
        assert_eq!(d.next_frame().unwrap(), None);
        d.feed(&bytes[5..]);
        let f = d.next_frame().unwrap().expect("a whole frame");
        assert_eq!(d.next_frame().unwrap(), None);
        assert_eq!(d.pending(), 0);
        f
    }

    #[test]
    fn protocol_md_examples_round_trip() {
        let v = spec_vectors();
        assert_eq!(v.len(), 9, "PROTOCOL.md has nine hex examples");

        // HELLO
        let f = one_frame(&v[0]);
        assert_eq!((f.ty, f.stream), (ty::HELLO, 0));
        let hello: Hello = serde_json::from_slice(&f.payload).unwrap();
        assert_eq!(hello, Hello { proto: [1, 0], client: "example/0.1".into() });
        assert_eq!(encode_json(ty::HELLO, 0, &hello), v[0]);

        // WELCOME
        let f = one_frame(&v[1]);
        assert_eq!(f.ty, ty::WELCOME);
        let w: Welcome = serde_json::from_slice(&f.payload).unwrap();
        assert_eq!(w.ns.as_deref(), Some("test"));
        assert_eq!(w.features, FEATURES.map(String::from).to_vec());
        assert_eq!(w.max_frame, DEFAULT_MAX_FRAME as u64);
        assert_eq!(encode_json(ty::WELCOME, 0, &w), v[1]);

        // REQUEST create
        let f = one_frame(&v[2]);
        assert_eq!(f.ty, ty::REQUEST);
        let r: Request = serde_json::from_slice(&f.payload).unwrap();
        let want = Request {
            req: 1,
            op: Op::Create(Create {
                id: "t1".into(),
                argv: Some(vec!["bash".into(), "-l".into()]),
                cols: 80,
                rows: 24,
                ..Default::default()
            }),
        };
        assert_eq!(r, want);
        assert_eq!(encode_json(ty::REQUEST, 0, &want), v[2]);

        // REPLY subscribe
        let f = one_frame(&v[3]);
        assert_eq!(f.ty, ty::REPLY);
        let head: ReplyHead = serde_json::from_slice(&f.payload).unwrap();
        assert!(head.ok && head.req == 2 && head.error.is_none());
        let body: SubscribeReply = serde_json::from_slice(&f.payload).unwrap();
        assert_eq!(body, SubscribeReply { handle: 7, role: Role::Attach, seq: 2, cols: 80, rows: 24 });
        assert_eq!(encode_json(ty::REPLY, 0, &ReplyOk { req: 2, ok: true, body: &body }), v[3]);

        // REPAINT
        let f = one_frame(&v[4]);
        assert_eq!((f.ty, f.stream), (ty::REPAINT, 7));
        let (head, vt) = parse_repaint(&f.payload).unwrap();
        assert_eq!(head, RepaintHead { seq: 2, cols: 80, rows: 24, flags: 0 });
        assert_eq!(vt, b"\x1b[!p\x1b[H\x1b[2J$ ");
        assert_eq!(encode_repaint(7, head, vt), v[4]);

        // INPUT
        let f = one_frame(&v[5]);
        assert_eq!((f.ty, f.stream, f.payload.as_slice()), (ty::INPUT, 7, b"ls\r".as_slice()));
        assert_eq!(encode(ty::INPUT, 7, b"ls\r"), v[5]);

        // OUTPUT
        let f = one_frame(&v[6]);
        assert_eq!((f.ty, f.stream), (ty::OUTPUT, 7));
        let (seq, bytes) = parse_output(&f.payload).unwrap();
        assert_eq!((seq, bytes), (2, b"ls\r\n".as_slice()));
        assert_eq!(encode_output(7, 2, b"ls\r\n"), v[6]);

        // EVENT size
        let f = one_frame(&v[7]);
        assert_eq!((f.ty, f.stream), (ty::EVENT, 7));
        let ev: Event = serde_json::from_slice(&f.payload).unwrap();
        assert_eq!(ev, Event::Size { cols: 100, rows: 30, seq: 4096 });
        assert_eq!(encode_json(ty::EVENT, 7, &ev), v[7]);

        // ERROR version
        let f = one_frame(&v[8]);
        assert_eq!(f.ty, ty::ERROR);
        let e: WireError = serde_json::from_slice(&f.payload).unwrap();
        assert_eq!(e, WireError::new(code::VERSION, "daemon speaks 1.x; client sent 2.0"));
        assert_eq!(encode_json(ty::ERROR, 0, &e), v[8]);
    }

    #[test]
    fn every_op_round_trips() {
        let ops = vec![
            Op::List,
            Op::Ping,
            Op::Stop,
            Op::Kill(Kill { id: "t".into(), signal: Some("TERM".into()) }),
            Op::Subscribe(Subscribe {
                id: "t".into(),
                mode: Mode::Raw,
                role: Role::Own,
                history_rows: Some(10),
                flow: Some(Flow::Block),
                cols: Some(100),
                rows: Some(30),
            }),
            Op::Unsubscribe(HandleOnly { handle: 3 }),
            Op::Take(Take { handle: 3, cols: None, rows: None }),
            Op::Resize(Resize { handle: 3, cols: 1, rows: 4096 }),
            Op::Repaint(RepaintOp { handle: 3, history_rows: None }),
            Op::View(View { handle: 3, delta: Some(-5), live: None }),
            Op::Capture(Capture {
                id: "t".into(),
                format: Some(CaptureFormat::Vt),
                history_rows: Some(9),
                unwrap: Some(true),
            }),
            Op::Status,
            Op::StatusFollow(StatusFollow { interval_ms: Some(250) }),
            Op::StatusFollow(StatusFollow::default()),
            Op::StatusUnfollow,
            Op::Env(EnvQuery { id: "t".into() }),
            Op::Key(Key {
                handle: 3,
                code: "Enter".into(),
                key: "Enter".into(),
                mods: vec!["Shift".into()],
                text: String::new(),
                action: Some(KeyAction::Repeat),
                option_as_alt: OptionAsAlt::False,
            }),
            Op::Key(Key { handle: 3, key: "é".into(), text: "é".into(), ..Default::default() }),
            Op::Key(Key {
                handle: 3,
                key: "å".into(),
                text: "å".into(),
                option_as_alt: OptionAsAlt::True,
                ..Default::default()
            }),
            Op::Paste(Paste { handle: 3, text: "a\nb".into(), allow_unsafe: Some(true) }),
            Op::Mouse(Mouse {
                handle: 3,
                action: MouseAction::Move,
                button: MouseButton::None,
                col: 4.5,
                row: 0.0,
                mods: vec!["Control".into()],
            }),
            Op::Mouse(Mouse { handle: 3, button: MouseButton::WheelDown, col: 1.0, row: 2.0, ..Default::default() }),
            Op::Mouse(Mouse { handle: 3, button: MouseButton::Extra(9), ..Default::default() }),
        ];
        for op in ops {
            let r = Request { req: 9, op };
            let bytes = encode_json(ty::REQUEST, 0, &r);
            let f = one_frame(&bytes);
            let back: Request = serde_json::from_slice(&f.payload).unwrap();
            assert_eq!(back, r);
        }
        // A newer minor's extra fields are ignored.
        let r: Request = serde_json::from_str(r#"{"req":1,"op":"list","future":{"x":1}}"#).unwrap();
        assert_eq!(r.op, Op::List);
    }

    /// (1.3) `option_as_alt` is `"auto"`, `true` or `false` on the wire; absent is auto, and auto
    /// is left out when sent.
    #[test]
    fn option_as_alt_is_auto_true_or_false() {
        let key = |json: &str| match serde_json::from_str::<Request>(json).map(|r| r.op) {
            Ok(Op::Key(k)) => Ok(k.option_as_alt),
            Ok(op) => panic!("{op:?}"),
            Err(e) => Err(e.to_string()),
        };
        assert_eq!(key(r#"{"req":1,"op":"key","handle":1}"#), Ok(OptionAsAlt::Auto));
        assert_eq!(key(r#"{"req":1,"op":"key","handle":1,"option_as_alt":"auto"}"#), Ok(OptionAsAlt::Auto));
        assert_eq!(key(r#"{"req":1,"op":"key","handle":1,"option_as_alt":true}"#), Ok(OptionAsAlt::True));
        assert_eq!(key(r#"{"req":1,"op":"key","handle":1,"option_as_alt":false}"#), Ok(OptionAsAlt::False));
        for bad in [r#""true""#, r#""left""#, "1", "null"] {
            let e = key(&format!(r#"{{"req":1,"op":"key","handle":1,"option_as_alt":{bad}}}"#)).unwrap_err();
            assert!(e.contains(r#""auto", true or false"#), "{bad}: {e}");
        }
        let json = |o| serde_json::to_string(&Key { handle: 1, option_as_alt: o, ..Default::default() }).unwrap();
        assert_eq!(json(OptionAsAlt::Auto), r#"{"handle":1}"#);
        assert_eq!(json(OptionAsAlt::False), r#"{"handle":1,"option_as_alt":false}"#);
        assert_eq!("false".parse(), Ok(OptionAsAlt::False));
        assert!("left".parse::<OptionAsAlt>().is_err());
    }

    /// (1.4) A `mouse` button is a name, or a number for X11's buttons 8–11; 1–7 go by name, and
    /// `button` is required.
    #[test]
    fn a_mouse_button_is_a_name_or_an_extra_buttons_number() {
        let button = |b: &str| match serde_json::from_str::<Request>(&format!(
            r#"{{"req":1,"op":"mouse","handle":1,"col":0,"row":0,"button":{b}}}"#
        ))
        .map(|r| r.op)
        {
            Ok(Op::Mouse(m)) => Ok(m.button),
            Ok(op) => panic!("{op:?}"),
            Err(e) => Err(e.to_string()),
        };
        assert_eq!(button(r#""left""#), Ok(MouseButton::Left));
        assert_eq!(button(r#""wheel-right""#), Ok(MouseButton::WheelRight));
        assert_eq!(button("8"), Ok(MouseButton::Extra(8)));
        assert_eq!(button("11"), Ok(MouseButton::Extra(11)));
        assert!(button("4").unwrap_err().contains("goes by its name"));
        for bad in ["12", "0", "-1", r#""8""#, r#""back""#, "null"] {
            assert!(button(bad).is_err(), "{bad}");
        }
        let r: Result<Request, _> = serde_json::from_str(r#"{"req":1,"op":"mouse","handle":1,"col":0,"row":0}"#);
        assert!(r.unwrap_err().to_string().contains("button"));
        let m: Request =
            serde_json::from_str(r#"{"req":1,"op":"mouse","handle":1,"button":"left","col":2,"row":3}"#).unwrap();
        assert_eq!(
            m.op,
            Op::Mouse(Mouse { handle: 1, button: MouseButton::Left, col: 2.0, row: 3.0, ..Default::default() })
        );
        assert_eq!("wheel-up".parse(), Ok(MouseButton::WheelUp));
        assert_eq!("10".parse(), Ok(MouseButton::Extra(10)));
        assert_eq!(MouseButton::Extra(10).to_string(), "10");
        assert_eq!(serde_json::to_string(&MouseButton::Extra(8)).unwrap(), "8");
        assert_eq!(serde_json::to_string(&MouseButton::WheelLeft).unwrap(), r#""wheel-left""#);
    }

    #[test]
    fn every_event_round_trips() {
        let evs = vec![
            Event::Size { cols: 1, rows: 2, seq: 3 },
            Event::Title { title: "t".into() },
            Event::Modes(Modes { alt: true, mouse: true, ..Default::default() }),
            Event::Bell,
            Event::Pwd { pwd: "/".into() },
            Event::Role { role: Role::Attach },
            Event::Lagged { dropped: 9, seq: 10 },
            Event::Exit { code: Some(0), signal: None, seq: 11 },
            Event::Exit { code: None, signal: Some("HUP".into()), seq: 11 },
            Event::Closed,
            Event::Error { code: code::READ_ONLY.into(), message: "m".into() },
        ];
        for ev in evs {
            let s = serde_json::to_vec(&ev).unwrap();
            assert_eq!(serde_json::from_slice::<Event>(&s).unwrap(), ev);
        }
        let unknown: Event = serde_json::from_str(r#"{"ev":"from_the_future","x":1}"#).unwrap();
        assert_eq!(unknown, Event::Unknown);
    }

    /// PROTOCOL.md's example status document is a `Status`, field for field: the spec and the
    /// types can't drift apart.
    #[test]
    fn protocol_md_status_example_is_a_status() {
        let spec = include_str!("../../../docs/termd/PROTOCOL.md");
        let start = spec.find("```json\n{\"at\":").expect("the status example") + "```json\n".len();
        let end = start + spec[start..].find("\n```").unwrap();
        let example: serde_json::Value = serde_json::from_str(&spec[start..end]).unwrap();
        let doc: Status = serde_json::from_value(example.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(&doc).unwrap(),
            example,
            "a field in the example the type doesn't carry, or the reverse"
        );
        let ev: Event = serde_json::from_str(&{
            let mut v = example.clone();
            v["ev"] = "status".into();
            v.to_string()
        })
        .unwrap();
        assert_eq!(ev, Event::Status(Box::new(doc)));
    }

    #[test]
    fn decoder_rejects_bad_frames() {
        let mut d = FrameDecoder::default();
        d.feed(&[3, 0, 0, 0, 1, 0, 0]);
        assert_eq!(d.next_frame(), Err(FrameError::BadLen(3)));
        let mut d = FrameDecoder::new(16);
        d.feed(&encode(ty::INPUT, 1, &[0; 17]));
        assert!(matches!(d.next_frame(), Err(FrameError::TooLarge { len: 17, max: 16 })));
    }

    #[test]
    fn decoder_handles_many_frames_in_one_read() {
        let mut bytes = Vec::new();
        for i in 0..1000u32 {
            bytes.extend(encode_output(i, u64::from(i) * 3, b"abc"));
        }
        let mut d = FrameDecoder::default();
        let mut n = 0;
        for chunk in bytes.chunks(7) {
            d.feed(chunk);
            while let Some(f) = d.next_frame().unwrap() {
                assert_eq!(f.stream, n);
                assert_eq!(parse_output(&f.payload).unwrap(), (u64::from(n) * 3, b"abc".as_slice()));
                n += 1;
            }
        }
        assert_eq!(n, 1000);
    }
}
