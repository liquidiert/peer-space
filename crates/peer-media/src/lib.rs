//! iroh transport for PeerSpace's proximity audio/video, compiled to wasm for the browser.
//!
//! Browsers cannot open raw UDP sockets, so all traffic flows through iroh relays. Each
//! pair of peers shares one QUIC connection on a dedicated ALPN, and the two media kinds
//! use the QUIC primitive that suits them:
//!
//! - audio goes out as unreliable datagrams: a late voice packet is worse than a lost one,
//!   and a datagram never blocks the ones behind it;
//! - video (and control messages) go over long-lived uni streams, one per track, framed as
//!   `u32 LE length + payload`. Delta frames must arrive in order to be decodable, which a
//!   stream gives for free. Each stream has a small send queue: when it is full the frame
//!   is refused (`send` returns false) rather than buffered, so a slow link drops frames
//!   instead of building up seconds of latency. The JS side then waits for a keyframe.
//!
//! The JS side only sees opaque byte payloads; codecs and app logic live in TypeScript.

use std::{rc::Rc, str::FromStr};

use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, RelayUrl, SecretKey, Signature,
    address_lookup::memory::MemoryLookup,
    endpoint::{Connection, RecvStream, SendStream, VarInt, presets},
};
use js_sys::{Function, Object, Reflect, Uint8Array};
use tokio::sync::mpsc;
use wasm_bindgen::prelude::*;

/// Application protocol for PeerSpace media connections.
const ALPN: &[u8] = b"peerspace/media/1";
/// Largest single stream message accepted (a high-resolution screen-share keyframe).
const MAX_MESSAGE_SIZE: usize = 4 * 1024 * 1024;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn set(obj: &Object, key: &str, value: &JsValue) {
    let _ = Reflect::set(obj, &key.into(), value);
}

fn emit(cb: &Function, kind: &str, data: Option<&[u8]>, reason: Option<String>) {
    let obj = Object::new();
    set(&obj, "type", &kind.into());
    if let Some(data) = data {
        set(&obj, "data", &Uint8Array::from(data).into());
    }
    if let Some(reason) = reason {
        set(&obj, "reason", &reason.into());
    }
    let _ = cb.call1(&JsValue::NULL, &obj);
}

/// A running iroh endpoint that speaks the media ALPN.
#[wasm_bindgen]
pub struct MediaNode {
    endpoint: Endpoint,
    lookup: MemoryLookup,
}

#[wasm_bindgen]
impl MediaNode {
    /// Bind a new endpoint with a fresh identity. `relays` lists relay URLs to use instead
    /// of n0's public ones (pass an empty array for the defaults).
    pub async fn spawn(relays: Vec<String>) -> Result<MediaNode, JsError> {
        let lookup = MemoryLookup::new();
        let mut builder = Endpoint::builder(presets::N0)
            .secret_key(SecretKey::generate())
            .address_lookup(lookup.clone())
            .alpns(vec![ALPN.to_vec()]);
        if !relays.is_empty() {
            let map = RelayMap::try_from_iter(relays.iter().map(String::as_str)).map_err(js_err)?;
            builder = builder.relay_mode(RelayMode::Custom(map));
        }
        let endpoint = builder.bind().await.map_err(js_err)?;
        Ok(MediaNode { endpoint, lookup })
    }

    /// This endpoint's id (public key string).
    #[wasm_bindgen(js_name = endpointId)]
    pub fn endpoint_id(&self) -> String {
        self.endpoint.id().to_string()
    }

    /// Sign `data` with this endpoint's ed25519 key (64-byte signature).
    pub fn sign(&self, data: &[u8]) -> Vec<u8> {
        self.endpoint.secret_key().sign(data).to_bytes().to_vec()
    }

    /// Resolves once a home relay is connected. Returns its URL, if any.
    pub async fn online(&self) -> Option<String> {
        self.endpoint.online().await;
        self.relay_url()
    }

    /// Current home relay URL (may be empty before `online` resolves).
    #[wasm_bindgen(js_name = relayUrl)]
    pub fn relay_url(&self) -> Option<String> {
        self.endpoint.addr().relay_urls().next().map(|u| u.to_string())
    }

    /// Teach the endpoint how to reach a peer via its relay, so dialing does not depend on
    /// DNS/pkarr address lookup.
    #[wasm_bindgen(js_name = addPeer)]
    pub fn add_peer(&self, endpoint_id: String, relay_url: Option<String>) -> Result<(), JsError> {
        let id = EndpointId::from_str(&endpoint_id).map_err(js_err)?;
        let mut addr = EndpointAddr::new(id);
        if let Some(url) = relay_url {
            addr = addr.with_relay_url(RelayUrl::from_str(&url).map_err(js_err)?);
        }
        self.lookup.add_endpoint_info(addr);
        Ok(())
    }

    /// Dial a peer (call `addPeer` first).
    pub async fn connect(&self, endpoint_id: String) -> Result<MediaConn, JsError> {
        let id = EndpointId::from_str(&endpoint_id).map_err(js_err)?;
        let conn = self.endpoint.connect(id, ALPN).await.map_err(js_err)?;
        Ok(MediaConn::new(conn))
    }

    /// Wait for the next incoming media connection. Resolves to `undefined` once the
    /// endpoint is closed. Failed handshakes are skipped.
    pub async fn accept(&self) -> Option<MediaConn> {
        loop {
            let incoming = self.endpoint.accept().await?;
            let Ok(accepting) = incoming.accept() else { continue };
            match accepting.await {
                Ok(conn) if conn.alpn() == ALPN => return Some(MediaConn::new(conn)),
                Ok(conn) => conn.close(VarInt::from_u32(1), b"unknown alpn"),
                Err(_) => continue,
            }
        }
    }

    /// Shut the endpoint down.
    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

/// Verify an ed25519 `signature` over `data` made by `endpoint_id`.
#[wasm_bindgen]
pub fn verify(endpoint_id: &str, data: &[u8], signature: &[u8]) -> bool {
    let Ok(id) = EndpointId::from_str(endpoint_id) else {
        return false;
    };
    let Ok(sig) = <[u8; 64]>::try_from(signature) else {
        return false;
    };
    id.verify(data, &Signature::from_bytes(&sig)).is_ok()
}

/// One media connection to one peer.
#[wasm_bindgen]
pub struct MediaConn {
    conn: Connection,
    started: Rc<std::cell::Cell<bool>>,
}

impl MediaConn {
    fn new(conn: Connection) -> Self {
        MediaConn {
            conn,
            started: Rc::new(std::cell::Cell::new(false)),
        }
    }
}

#[wasm_bindgen]
impl MediaConn {
    /// The authenticated endpoint id of the other side.
    #[wasm_bindgen(js_name = remoteId)]
    pub fn remote_id(&self) -> String {
        self.conn.remote_id().to_string()
    }

    /// Start delivering incoming traffic. `on_event` receives
    /// `{type: "datagram", data}`, `{type: "message", data}` (one framed stream message)
    /// and finally `{type: "closed", reason}`. Calling it twice is a no-op.
    pub fn start(&self, on_event: Function) {
        if self.started.replace(true) {
            return;
        }

        let conn = self.conn.clone();
        let cb = on_event.clone();
        wasm_bindgen_futures::spawn_local(async move {
            while let Ok(data) = conn.read_datagram().await {
                emit(&cb, "datagram", Some(&data), None);
            }
        });

        let conn = self.conn.clone();
        let cb = on_event.clone();
        wasm_bindgen_futures::spawn_local(async move {
            while let Ok(recv) = conn.accept_uni().await {
                wasm_bindgen_futures::spawn_local(read_messages(recv, cb.clone()));
            }
        });

        let conn = self.conn.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let reason = conn.closed().await;
            emit(&on_event, "closed", None, Some(reason.to_string()));
        });
    }

    /// Send one unreliable datagram. Returns false when it could not be queued (too large,
    /// or the connection is gone); the caller just moves on, as a lost packet would.
    #[wasm_bindgen(js_name = sendDatagram)]
    pub fn send_datagram(&self, data: Vec<u8>) -> bool {
        self.conn.send_datagram(data.into()).is_ok()
    }

    /// Largest datagram the path currently allows, if datagrams are supported at all.
    #[wasm_bindgen(js_name = maxDatagramSize)]
    pub fn max_datagram_size(&self) -> Option<usize> {
        self.conn.max_datagram_size()
    }

    /// Open an ordered stream for one track. Higher `priority` is sent first when the link
    /// is congested. At most `queue` messages wait to be written; beyond that `send` refuses.
    #[wasm_bindgen(js_name = openStream)]
    pub async fn open_stream(&self, priority: i32, queue: usize) -> Result<TrackSender, JsError> {
        let stream = self.conn.open_uni().await.map_err(js_err)?;
        let _ = stream.set_priority(priority);
        let (tx, rx) = mpsc::channel::<Vec<u8>>(queue.max(1));
        wasm_bindgen_futures::spawn_local(write_messages(stream, rx));
        Ok(TrackSender { tx: Some(tx) })
    }

    /// Smoothed round-trip time in milliseconds over the best path, for diagnostics.
    #[wasm_bindgen(js_name = rttMs)]
    pub fn rtt_ms(&self) -> Option<f64> {
        self.conn
            .paths()
            .into_iter()
            .map(|p| p.rtt())
            .min()
            .map(|d| d.as_secs_f64() * 1000.0)
    }

    /// Close the connection.
    pub fn close(&self) {
        self.conn.close(VarInt::from_u32(0), b"bye");
    }
}

async fn write_messages(mut stream: SendStream, mut rx: mpsc::Receiver<Vec<u8>>) {
    while let Some(msg) = rx.recv().await {
        let len = (msg.len() as u32).to_le_bytes();
        if stream.write_all(&len).await.is_err() || stream.write_all(&msg).await.is_err() {
            return;
        }
    }
    let _ = stream.finish();
}

async fn read_messages(mut recv: RecvStream, cb: Function) {
    let mut len = [0u8; 4];
    loop {
        if recv.read_exact(&mut len).await.is_err() {
            return;
        }
        let n = u32::from_le_bytes(len) as usize;
        if n > MAX_MESSAGE_SIZE {
            let _ = recv.stop(VarInt::from_u32(2));
            return;
        }
        let mut buf = vec![0u8; n];
        if recv.read_exact(&mut buf).await.is_err() {
            return;
        }
        emit(&cb, "message", Some(&buf), None);
    }
}

/// Sending half of one ordered track stream.
#[wasm_bindgen]
pub struct TrackSender {
    tx: Option<mpsc::Sender<Vec<u8>>>,
}

#[wasm_bindgen]
impl TrackSender {
    /// Queue one message. Returns false when the queue is full (the link is not keeping up)
    /// or the stream is closed; the message is dropped in that case.
    pub fn send(&self, data: Vec<u8>) -> bool {
        self.tx.as_ref().is_some_and(|tx| tx.try_send(data).is_ok())
    }

    /// Messages still waiting to be written.
    pub fn queued(&self) -> usize {
        self.tx
            .as_ref()
            .map_or(0, |tx| tx.max_capacity() - tx.capacity())
    }

    /// Finish the stream once the queued messages are written.
    pub fn close(&mut self) {
        self.tx = None;
    }
}
