//! A connection's outbound queue. Owner threads and the request handler push frames; the
//! connection's writer task drains them to the socket in order. Each subscription's share
//! of the queue is counted, so an owner thread can drop a lagging lossy subscriber's
//! frames or pause its PTY for a blocking owner (PROTOCOL.md, "Flow control").

use std::collections::VecDeque;
use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

/// A lossy subscriber whose queue would pass this is dropped and, once drained, resynced
/// (`--lossy-queue`).
static LOSSY_MAX: AtomicUsize = AtomicUsize::new(4 << 20);
/// A blocking owner whose queue passes this pauses the PTY (`--block-high`)...
static BLOCK_HIGH: AtomicUsize = AtomicUsize::new(1 << 20);
/// ...until it drains below this (`--block-low`).
static BLOCK_LOW: AtomicUsize = AtomicUsize::new(256 << 10);

/// Sets the flow limits, once, at the brain's start.
pub fn set_limits(lossy: usize, high: usize, low: usize) {
    LOSSY_MAX.store(lossy, SeqCst);
    BLOCK_HIGH.store(high, SeqCst);
    BLOCK_LOW.store(low, SeqCst);
}

pub fn lossy_max() -> usize {
    LOSSY_MAX.load(SeqCst)
}

/// Wakes an owner thread out of `poll`: an eventfd (Linux) or a pipe.
pub struct Wake {
    rd: OwnedFd,
    wr: Option<OwnedFd>,
}

impl Wake {
    pub fn new() -> std::io::Result<Self> {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            use rustix::event::{EventfdFlags, eventfd};
            let fd = eventfd(0, EventfdFlags::CLOEXEC | EventfdFlags::NONBLOCK)?;
            Ok(Wake { rd: fd, wr: None })
        }
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        {
            use rustix::pipe::{PipeFlags, pipe_with};
            let (rd, wr) = pipe_with(PipeFlags::CLOEXEC | PipeFlags::NONBLOCK)?;
            Ok(Wake { rd, wr: Some(wr) })
        }
    }

    pub fn fd(&self) -> &OwnedFd {
        &self.rd
    }

    pub fn wake(&self) {
        let one = 1u64.to_ne_bytes();
        let fd = self.wr.as_ref().unwrap_or(&self.rd);
        let _ = rustix::io::write(fd, if self.wr.is_some() { &one[..1] } else { &one[..] });
    }

    /// Clears pending wakes.
    pub fn drain(&self) {
        let mut buf = [0u8; 64];
        while matches!(rustix::io::read(&self.rd, &mut buf), Ok(n) if n > 0) {}
    }
}

/// What a subscription shares between its owner thread and its connection's writer.
pub struct SubShared {
    /// Bytes of this subscription's frames queued and not yet written.
    pub queued: AtomicUsize,
    /// A blocking owner over its high mark: the owner thread stops reading the PTY.
    pub paused: AtomicBool,
    /// A lossy subscriber whose frames were dropped: the owner thread queues nothing more
    /// for it but `Keep` frames, and resyncs it once `queued` reaches 0.
    pub lagging: AtomicBool,
    /// Resyncs so far (the status document's `lags`).
    pub lags: AtomicU64,
    pub wake: Arc<Wake>,
}

impl SubShared {
    pub fn new(wake: Arc<Wake>) -> Self {
        Self {
            queued: AtomicUsize::new(0),
            paused: AtomicBool::new(false),
            lagging: AtomicBool::new(false),
            lags: AtomicU64::new(0),
            wake,
        }
    }

    /// The owner thread pauses reads when over the high mark. Rechecks after setting the
    /// flag so a writer that drained in between can't leave it paused forever.
    pub fn maybe_pause(&self) -> bool {
        if self.queued.load(SeqCst) <= BLOCK_HIGH.load(SeqCst) {
            return false;
        }
        self.paused.store(true, SeqCst);
        if self.queued.load(SeqCst) < BLOCK_LOW.load(SeqCst) {
            self.paused.store(false, SeqCst);
            return false;
        }
        true
    }

    fn written(&self, n: usize) {
        let left = self.queued.fetch_sub(n, SeqCst) - n;
        if left < BLOCK_LOW.load(SeqCst) && self.paused.swap(false, SeqCst) {
            self.wake.wake();
        }
        if left == 0 && self.lagging.load(SeqCst) {
            self.wake.wake();
        }
    }
}

/// How a subscription's frame fares when the subscriber lags.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `OUTPUT` or `REPAINT`. `prev_end` is the subscriber's stream position before this
    /// frame: if it is dropped, delivery stopped there.
    Data { prev_end: u64 },
    /// An event a resync restates (`title`, `modes`, `pwd`, `size`) or one that loses
    /// nothing by going (`bell`): dropped with the data.
    Event,
    /// Never dropped: `role`, `lagged`, `exit`, `closed`, `error`. None can be produced
    /// at a rate the program controls.
    Keep,
}

pub struct Item {
    head: Vec<u8>,
    body: Option<Arc<[u8]>>,
    sub: Option<Arc<SubShared>>,
    kind: Kind,
}

impl Item {
    fn len(&self) -> usize {
        self.head.len() + self.body.as_ref().map_or(0, |b| b.len())
    }
}

#[derive(Default)]
struct Q {
    items: VecDeque<Item>,
    closed: bool,
    close_after: bool,
}

#[derive(Default)]
pub struct ConnOut {
    q: Mutex<Q>,
    notify: Notify,
}

impl ConnOut {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn push(&self, item: Item) {
        let mut q = self.q.lock().unwrap();
        if q.closed || q.close_after {
            return;
        }
        if let Some(s) = &item.sub {
            s.queued.fetch_add(item.len(), SeqCst);
        }
        q.items.push_back(item);
        drop(q);
        self.notify.notify_one();
    }

    /// A connection-level frame (reply, welcome, error, an `INPUT`'s error event).
    pub fn frame(&self, bytes: Vec<u8>) {
        self.push(Item { head: bytes, body: None, sub: None, kind: Kind::Keep });
    }

    /// A frame counted against a subscription's queue.
    pub fn sub_frame(&self, sub: &Arc<SubShared>, kind: Kind, head: Vec<u8>, body: Option<Arc<[u8]>>) {
        self.push(Item { head, body, sub: Some(sub.clone()), kind });
    }

    /// Removes a subscription's queued frames, all but `Keep` ones. Frames the writer has
    /// already taken still go out. Returns where the subscriber's stream stops: the
    /// `prev_end` of the first `Data` frame dropped, or `None` when none was.
    pub fn drop_sub_frames(&self, sub: &Arc<SubShared>) -> Option<u64> {
        let mut q = self.q.lock().unwrap();
        let mut stop = None;
        let mut freed = 0usize;
        q.items.retain(|it| {
            let mine = it.sub.as_ref().is_some_and(|s| Arc::ptr_eq(s, sub)) && it.kind != Kind::Keep;
            if mine {
                freed += it.len();
                if let Kind::Data { prev_end } = it.kind {
                    stop.get_or_insert(prev_end);
                }
            }
            !mine
        });
        drop(q);
        if freed > 0 {
            sub.written(freed);
        }
        stop
    }

    /// Stops the queue now: queued frames are discarded and later pushes ignored.
    pub fn close(&self) {
        let mut q = self.q.lock().unwrap();
        q.closed = true;
        let items: Vec<Item> = q.items.drain(..).collect();
        drop(q);
        for it in items {
            if let Some(s) = &it.sub {
                s.written(it.len());
            }
        }
        self.notify.notify_one();
    }

    /// Writes what is queued, then ends the connection (after an `ERROR`, or `stop`).
    pub fn close_after_drain(&self) {
        self.q.lock().unwrap().close_after = true;
        self.notify.notify_one();
    }

    pub fn is_closed(&self) -> bool {
        self.q.lock().unwrap().closed
    }

    /// Writes the queue to `w` until the connection closes.
    pub async fn run_writer<W: tokio::io::AsyncWrite + Unpin>(&self, w: W) {
        use tokio::io::AsyncWriteExt;
        let mut w = tokio::io::BufWriter::with_capacity(256 << 10, w);
        loop {
            let batch: Vec<Item> = loop {
                let notified = self.notify.notified();
                let finish;
                {
                    let mut q = self.q.lock().unwrap();
                    if q.closed {
                        return;
                    }
                    if !q.items.is_empty() {
                        let n = q.items.len().min(256);
                        break q.items.drain(..n).collect();
                    }
                    finish = q.close_after;
                    if finish {
                        q.closed = true;
                    }
                }
                if finish {
                    let _ = w.flush().await;
                    let _ = w.shutdown().await;
                    return;
                }
                notified.await;
            };
            let mut ok = true;
            for it in &batch {
                if w.write_all(&it.head).await.is_err() {
                    ok = false;
                    break;
                }
                if let Some(b) = &it.body
                    && w.write_all(b).await.is_err()
                {
                    ok = false;
                    break;
                }
            }
            if ok && w.flush().await.is_err() {
                ok = false;
            }
            for it in &batch {
                if let Some(s) = &it.sub {
                    s.written(it.len());
                }
            }
            if !ok {
                self.close();
                return;
            }
        }
    }
}
