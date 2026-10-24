"use client";
import { useRef, useState, useEffect, useMemo } from "react";
import JSZip from "jszip";

const H = 240, B = 256, MAXPPS = 200000;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = t => Math.floor(t / 60) + ":" + (t % 60).toFixed(3).padStart(6, "0");
const safe = n => ((n || "").replace(/[\\/:*?"<>|]/g, "_").trim()) || "part";
const ACCEPTED_TYPES = "audio/*,video/*,.mp3,.wav,.ogg,.m4a,.flac,.aac,.wma,.aiff,.mp4,.mov,.webm,.mkv,.avi,.m4v,.3gp,.ogv";

function save(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function wav(chs, sr) {
  const n = chs[0].length, c = chs.length, v = new DataView(new ArrayBuffer(44 + n * c * 2));
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n * c * 2, true);
  w(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, c, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * c * 2, true);
  v.setUint16(32, c * 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * c * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < c; k++) {
      v.setInt16(o, clamp(chs[k][i], -1, 1) * 32767, true);
      o += 2;
    }
  }
  return new Blob([v], { type: "audio/wav" });
}

async function mp3(chs, sr) {
  const { Mp3Encoder } = await import("@breezystack/lamejs");
  const enc = new Mp3Encoder(chs.length, sr, 128);
  const cv = f => {
    const o = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) o[i] = clamp(f[i], -1, 1) * 32767;
    return o;
  };
  const L = cv(chs[0]), R = chs[1] ? cv(chs[1]) : null, out = [];
  for (let i = 0; i < L.length; i += 1152) {
    const b = R ? enc.encodeBuffer(L.subarray(i, i + 1152), R.subarray(i, i + 1152)) : enc.encodeBuffer(L.subarray(i, i + 1152));
    if (b.length) out.push(b);
  }
  out.push(enc.flush());
  return new Blob(out, { type: "audio/mpeg" });
}

async function encode(buf, r, f) {
  const sr = buf.sampleRate, chs = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) {
    chs.push(buf.getChannelData(c).slice(Math.floor(r.s * sr), Math.floor(r.e * sr)));
  }
  return f === "mp3" ? mp3(chs, sr) : wav(chs, sr);
}

const Btn = ({ c = "", ...p }) => (
  <button {...p} className={"px-4 py-2 rounded-full text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed " + c} />
);

export default function Splitter() {
  const [buf, setBuf] = useState(null);
  const [key, setKey] = useState(0);
  const [fname, setFname] = useState("");
  const [isVideo, setIsVideo] = useState(false);
  const [videoUrl, setVideoUrl] = useState(null);
  const [showVideo, setShowVideo] = useState(true);
  const [regs, setRegs] = useState([]);
  const [sel, setSel] = useState(null);
  const [pps, setPps] = useState(100);
  const [start, setStart] = useState(0);
  const [W, setW] = useState(800);
  const [snap, setSnap] = useState(true);
  const [f, setF] = useState("mp3");
  const [busy, setBusy] = useState("");
  const [head, setHead] = useState(0);
  const [playing, setPlaying] = useState(false);

  const hist = useRef([]);
  const cv = useRef();
  const box = useRef();
  const drag = useRef(null);
  const ac = useRef();
  const src = useRef();
  const cnt = useRef(1);
  const raf = useRef();
  const S = useRef({});
  const videoRef = useRef(null);
  const videoUrlRef = useRef(null);

  const dur = buf ? buf.duration : 0;
  const sr = buf ? buf.sampleRate : 44100;
  const minPps = dur ? W / dur : 1;
  S.current = { pps, start, W, dur };

  useEffect(() => {
    return () => {
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    };
  }, []);

  const peaks = useMemo(() => {
    if (!buf) return null;
    const d = buf.getChannelData(0), n = Math.ceil(d.length / B), p = new Float32Array(n * 2);
    for (let j = 0; j < n; j++) {
      let mn = 1, mx = -1;
      const e = Math.min(d.length, (j + 1) * B);
      for (let i = j * B; i < e; i++) {
        const v = d[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      p[2 * j] = mn;
      p[2 * j + 1] = mx;
    }
    return p;
  }, [buf]);

  useEffect(() => {
    const el = box.current;
    if (!el || !buf) return;
    const w = el.clientWidth;
    setW(w);
    setPps(w / buf.duration);
    setStart(0);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    const wh = e => {
      e.preventDefault();
      const { pps: p, start: s0, W: w, dur: d } = S.current;
      const x = e.clientX - el.getBoundingClientRect().left;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        setStart(clamp(s0 + (e.deltaX || e.deltaY) / p, 0, Math.max(0, d - w / p)));
      } else {
        const np = clamp(p * Math.exp(-e.deltaY * 0.0025), w / d, MAXPPS);
        const t = s0 + x / p;
        setPps(np);
        setStart(clamp(t - x / np, 0, Math.max(0, d - w / np)));
      }
    };
    el.addEventListener("wheel", wh, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", wh);
    };
  }, [key]);

  useEffect(() => {
    const c = cv.current;
    if (!c || !buf) return;
    const d = window.devicePixelRatio || 1;
    c.width = W * d;
    c.height = H * d;
    const g = c.getContext("2d");
    g.scale(d, d);
    g.clearRect(0, 0, W, H);
    const data = buf.getChannelData(0), spp = sr / pps, mid = H / 2, n = peaks.length / 2;

    regs.forEach(r => {
      const x1 = (r.s - start) * pps, x2 = (r.e - start) * pps;
      if (x2 < 0 || x1 > W) return;
      g.fillStyle = r.id === sel ? "rgba(79,70,229,.24)" : "rgba(79,70,229,.12)";
      g.fillRect(x1, 0, x2 - x1, H);
      g.fillStyle = "#4f46e5";
      g.fillRect(x1 - 1, 0, 2, H);
      g.fillRect(x2 - 1, 0, 2, H);
      g.font = "600 11px Inter,sans-serif";
      g.fillText(r.name, Math.max(x1, 0) + 6, 15);
    });

    g.strokeStyle = "#1f2937";
    g.lineWidth = 1;
    g.beginPath();
    if (spp < 1) {
      for (let x = 0; x < W; x++) {
        const i = Math.floor(start * sr + x * spp);
        if (i < 0 || i >= data.length) continue;
        const y = mid - data[i] * mid * 0.92;
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
    } else {
      for (let x = 0; x < W; x++) {
        const i0 = Math.floor(start * sr + x * spp);
        if (i0 >= data.length) break;
        if (i0 < 0) continue;
        const i1 = Math.min(data.length, Math.floor(i0 + spp) + 1);
        let mn = 1, mx = -1;
        if (spp >= B) {
          for (let j = Math.floor(i0 / B); j <= Math.floor(i1 / B) && j < n; j++) {
            mn = Math.min(mn, peaks[2 * j]);
            mx = Math.max(mx, peaks[2 * j + 1]);
          }
        } else {
          for (let i = i0; i < i1; i++) {
            const v = data[i];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
        }
        g.moveTo(x + 0.5, mid - mx * mid * 0.92);
        g.lineTo(x + 0.5, mid - mn * mid * 0.92 + 1);
      }
    }
    g.stroke();

    const hx = (head - start) * pps;
    if (hx >= 0 && hx <= W) {
      g.fillStyle = "#ef4444";
      g.fillRect(hx, 0, 1.5, H);
    }
  }, [buf, peaks, pps, start, W, regs, sel, head]);

  const load = async file => {
    if (!file) return;
    const isVid = file.type.startsWith("video/") || /\.(mp4|webm|mov|mkv|avi|m4v|3gp|ogv|flv)$/i.test(file.name);
    setBusy(isVid ? "Extracting audio from video…" : "Decoding audio…");

    try {
      ac.current ??= new (window.AudioContext || window.webkitAudioContext)();
      if (ac.current.state === "suspended") {
        await ac.current.resume();
      }
      const rawData = await file.arrayBuffer();
      const b = await ac.current.decodeAudioData(rawData);
      stop();
      hist.current = [];
      cnt.current = 1;
      setRegs([]);
      setSel(null);
      setHead(0);
      setFname(file.name.replace(/\.[^.]+$/, ""));
      setBuf(b);

      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
      if (isVid) {
        const u = URL.createObjectURL(file);
        videoUrlRef.current = u;
        setVideoUrl(u);
        setIsVideo(true);
        setShowVideo(true);
      } else {
        videoUrlRef.current = null;
        setVideoUrl(null);
        setIsVideo(false);
      }

      setKey(k => k + 1);
    } catch (err) {
      console.error("Audio decoding error:", err);
      alert(
        isVid
          ? "Could not extract audio from this video file. Please verify that the video contains a valid audio track."
          : "This audio file could not be decoded. Please make sure it is a supported audio or video format."
      );
    }
    setBusy("");
  };

  const stop = () => {
    try {
      src.current && src.current.stop();
    } catch {}
    cancelAnimationFrame(raf.current);
    setPlaying(false);
    if (videoRef.current) {
      try {
        videoRef.current.pause();
      } catch {}
    }
  };

  const play = (s, e = dur) => {
    stop();
    ac.current ??= new (window.AudioContext || window.webkitAudioContext)();
    const x = ac.current;
    x.resume();
    const n = x.createBufferSource();
    n.buffer = buf;
    n.connect(x.destination);
    n.start(0, s, e - s);
    src.current = n;
    const t0 = x.currentTime;
    setPlaying(true);

    if (videoRef.current) {
      videoRef.current.currentTime = s;
      videoRef.current.play().catch(() => {});
    }

    const tick = () => {
      const t = s + x.currentTime - t0;
      if (t >= e) {
        setPlaying(false);
        if (videoRef.current) videoRef.current.pause();
        return;
      }
      setHead(t);
      if (videoRef.current && Math.abs(videoRef.current.currentTime - t) > 0.3) {
        videoRef.current.currentTime = t;
      }
      raf.current = requestAnimationFrame(tick);
    };
    tick();
  };

  const zc = t => {
    if (!snap) return t;
    const d = buf.getChannelData(0), i = Math.round(t * sr), R = Math.round(sr * 0.005);
    let best = i, bv = 1e9;
    for (let k = Math.max(1, i - R); k < Math.min(d.length, i + R); k++) {
      if ((d[k - 1] <= 0 && d[k] > 0) || (d[k - 1] >= 0 && d[k] < 0)) {
        const q = Math.abs(k - i);
        if (q < bv) {
          bv = q;
          best = k;
        }
      }
    }
    return best / sr;
  };

  const upd = (id, p) => setRegs(rs => rs.map(r => (r.id === id ? { ...r, ...p } : r)));
  const xOf = e => e.clientX - cv.current.getBoundingClientRect().left;

  const edgeAt = x => {
    for (const r of regs) {
      if (Math.abs((r.s - start) * pps - x) < 7) return { id: r.id, side: "s" };
      if (Math.abs((r.e - start) * pps - x) < 7) return { id: r.id, side: "e" };
    }
    return null;
  };

  const down = e => {
    const x = xOf(e), t = start + x / pps, ed = edgeAt(x);
    cv.current.setPointerCapture(e.pointerId);
    if (ed) {
      drag.current = { k: "edge", ...ed };
      setSel(ed.id);
    } else {
      drag.current = { k: "new", x0: x, t0: t, id: null, body: regs.find(r => t >= r.s && t <= r.e) };
    }
  };

  const move = e => {
    const x = xOf(e), d = drag.current, t = clamp(start + x / pps, 0, dur);
    if (!d) {
      cv.current.style.cursor = edgeAt(x) ? "ew-resize" : "crosshair";
      return;
    }
    if (d.k === "edge") {
      const tt = zc(t);
      setRegs(rs =>
        rs.map(r =>
          r.id !== d.id
            ? r
            : d.side === "s"
            ? { ...r, s: Math.min(tt, r.e - 0.001) }
            : { ...r, e: Math.max(tt, r.s + 0.001) }
        )
      );
    } else if (Math.abs(x - d.x0) > 4) {
      if (!d.id) {
        const id = (d.id = Math.random().toString(36).slice(2));
        setRegs(rs => [...rs, { id, name: safe(fname) + "-part-" + cnt.current++, s: t, e: t }]);
        setSel(id);
      }
      const a = zc(Math.min(d.t0, t)), b = zc(Math.max(d.t0, t)), id = d.id;
      setRegs(rs => rs.map(r => (r.id === id ? { ...r, s: a, e: b } : r)));
    }
  };

  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.k === "new" && !d.id) {
      setHead(d.t0);
      if (videoRef.current) videoRef.current.currentTime = d.t0;
      d.body && setSel(d.body.id);
    }
    setRegs(rs => rs.filter(r => r.e - r.s > 0.005));
  };

  const cut = id => {
    const r = regs.find(x => x.id === id), a = Math.floor(r.s * sr), b = Math.floor(r.e * sr), nl = buf.length - (b - a);
    if (nl < 1) return;
    stop();
    hist.current.push({ buf, regs });
    const nb = new AudioBuffer({ length: nl, numberOfChannels: buf.numberOfChannels, sampleRate: sr });
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const o = nb.getChannelData(c), i = buf.getChannelData(c);
      o.set(i.subarray(0, a));
      o.set(i.subarray(b), a);
    }
    const d = (b - a) / sr;
    setRegs(regs.filter(x => x.id !== id && (x.e <= r.s || x.s >= r.e)).map(x => (x.s >= r.e ? { ...x, s: x.s - d, e: x.e - d } : x)));
    setBuf(nb);
    setHead(0);
    if (videoRef.current) videoRef.current.currentTime = 0;
  };

  const undo = () => {
    const h = hist.current.pop();
    if (h) {
      stop();
      setBuf(h.buf);
      setRegs(h.regs);
    }
  };

  const names = () => {
    const u = {};
    return regs.map(r => {
      let n = safe(r.name);
      const k = n.toLowerCase();
      u[k] ? (n += " (" + ++u[k] + ")") : (u[k] = 1);
      return n + "." + f;
    });
  };

  const zip = async () => {
    const z = new JSZip(), ns = names();
    for (let i = 0; i < regs.length; i++) {
      setBusy(`Encoding ${i + 1}/${regs.length}…`);
      z.file(ns[i], await encode(buf, regs[i], f));
    }
    setBusy("Zipping…");
    save(await z.generateAsync({ type: "blob" }), safe(fname) + "-parts.zip");
    setBusy("");
  };

  const auto = async () => {
    const ns = names();
    for (let i = 0; i < regs.length; i++) {
      setBusy(`Downloading ${i + 1}/${regs.length}…`);
      save(await encode(buf, regs[i], f), ns[i]);
      await new Promise(r => setTimeout(r, 700));
    }
    setBusy("");
  };

  const one = async i => {
    setBusy("Encoding…");
    save(await encode(buf, regs[i], f), names()[i]);
    setBusy("");
  };

  const setZoom = v => {
    const np = minPps * Math.pow(MAXPPS / minPps, v), t = start + W / 2 / pps;
    setPps(np);
    setStart(clamp(t - W / 2 / np, 0, Math.max(0, dur - W / np)));
  };
  const zv = Math.log(pps / minPps) / Math.log(MAXPPS / minPps) || 0;

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-200/80 pb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight text-neutral-900">Audio & Video Splitter</h1>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700 tracking-wide">
              Browser Local
            </span>
          </div>
          <p className="text-neutral-500 mt-1 text-sm">
            Upload video or audio, select waveform parts, customize names, and download as single clips, sequential auto-download, or a ZIP package.
          </p>
        </div>

        {buf && (
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-neutral-300 text-neutral-700 text-sm font-medium hover:bg-neutral-100 cursor-pointer shadow-sm transition">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              Upload Another File
              <input type="file" accept={ACCEPTED_TYPES} hidden onChange={e => e.target.files[0] && load(e.target.files[0])} />
            </label>
          </div>
        )}
      </div>

      {!buf ? (
        <label
          onDragOver={e => e.preventDefault()}
          onDrop={e => {
            e.preventDefault();
            e.dataTransfer.files[0] && load(e.dataTransfer.files[0]);
          }}
          className="mt-10 grid place-items-center h-80 rounded-3xl border-2 border-dashed border-neutral-300 hover:border-indigo-600 hover:bg-indigo-50/30 transition-all cursor-pointer group shadow-sm"
        >
          <div className="text-center p-6">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-indigo-50 text-indigo-600 grid place-items-center group-hover:scale-110 group-hover:bg-indigo-100 transition duration-300 shadow-sm">
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            </div>
            <div className="text-xl font-semibold text-neutral-800">{busy || "Drop a video or audio file here"}</div>
            <div className="text-sm text-neutral-500 mt-2 max-w-lg mx-auto leading-relaxed">
              Supports <strong>MP4, WebM, MOV, MKV, MP3, WAV, M4A, AAC, OGG</strong> and more.
              <br />
              <span className="text-xs text-neutral-400">Everything processes 100% locally in your browser — zero file uploads to servers.</span>
            </div>
            <div className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-neutral-900 text-white text-sm font-medium shadow hover:bg-neutral-800 transition">
              Select Video or Audio File
            </div>
          </div>
          <input type="file" accept={ACCEPTED_TYPES} hidden onChange={e => e.target.files[0] && load(e.target.files[0])} />
        </label>
      ) : (
        <>
          {/* File summary and controls header */}
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 bg-neutral-100/70 p-3.5 px-4 rounded-2xl border border-neutral-200">
            <div className="flex items-center gap-2.5">
              <span className={"px-2.5 py-1 rounded-lg text-xs font-bold uppercase tracking-wider text-white " + (isVideo ? "bg-purple-600" : "bg-blue-600")}>
                {isVideo ? "Video" : "Audio"}
              </span>
              <span className="font-semibold text-sm text-neutral-800 truncate max-w-xs sm:max-w-md" title={fname}>
                {fname}
              </span>
              <span className="text-xs text-neutral-400 font-mono">
                {dur.toFixed(1)}s · {sr}Hz · {buf.numberOfChannels === 1 ? "Mono" : "Stereo"}
              </span>
            </div>

            <div className="flex items-center gap-2">
              {isVideo && (
                <button
                  onClick={() => setShowVideo(v => !v)}
                  className="px-3 py-1.5 rounded-full text-xs font-medium border border-neutral-300 bg-white hover:bg-neutral-50 shadow-sm transition flex items-center gap-1.5"
                >
                  <span className={"w-2 h-2 rounded-full " + (showVideo ? "bg-emerald-500" : "bg-neutral-400")} />
                  {showVideo ? "Hide Video Preview" : "Show Video Preview"}
                </button>
              )}
            </div>
          </div>

          {/* Synchronized video player if video file is loaded */}
          {isVideo && videoUrl && showVideo && (
            <div className="mt-4 rounded-2xl border border-neutral-200 bg-neutral-950 p-2 shadow-sm flex flex-col items-center">
              <video
                ref={videoRef}
                src={videoUrl}
                muted
                playsInline
                className="max-h-64 w-auto rounded-xl object-contain"
                onSeeked={() => {}}
              />
              <span className="text-[11px] text-neutral-400 mt-1.5 font-medium">
                Video synced to audio playhead & selections (muted to prevent sound overlap)
              </span>
            </div>
          )}

          {/* Player & timeline toolbar */}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Btn
              c="bg-neutral-900 text-white hover:bg-neutral-800 shadow-sm flex items-center gap-2"
              onClick={() => (playing ? stop() : play(head >= dur - 0.01 ? 0 : head))}
            >
              {playing ? (
                <>
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                  Pause
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                  Play
                </>
              )}
            </Btn>

            <span className="font-mono text-sm font-semibold text-neutral-700 bg-white border border-neutral-200 px-3 py-1.5 rounded-full shadow-xs">
              {fmt(head)} <span className="text-neutral-400 font-normal">/ {fmt(dur)}</span>
            </span>

            <div className="flex items-center gap-2 ml-auto text-sm text-neutral-600 bg-white border border-neutral-200 px-3 py-1 rounded-full shadow-xs">
              <span className="text-xs font-medium text-neutral-400 uppercase tracking-wider">Zoom</span>
              <input
                type="range"
                min="0"
                max="1"
                step=".001"
                value={clamp(zv, 0, 1)}
                onChange={e => setZoom(+e.target.value)}
                className="w-28 sm:w-36 accent-indigo-600"
              />
              <button
                className="px-2 py-0.5 text-xs font-semibold text-indigo-600 hover:text-indigo-800 rounded transition"
                onClick={() => {
                  setPps(minPps);
                  setStart(0);
                }}
              >
                Fit
              </button>
            </div>

            <label className="text-sm text-neutral-600 flex items-center gap-1.5 cursor-pointer select-none bg-white border border-neutral-200 px-3 py-1.5 rounded-full shadow-xs">
              <input
                type="checkbox"
                checked={snap}
                onChange={e => setSnap(e.target.checked)}
                className="accent-indigo-600 rounded"
              />
              <span className="text-xs font-medium">Snap to zero-cross</span>
            </label>

            <div className="flex items-center gap-1.5 bg-white border border-neutral-200 px-2 py-1 rounded-full shadow-xs text-sm">
              <span className="text-xs text-neutral-400 font-medium pl-1">Format:</span>
              <select
                value={f}
                onChange={e => setF(e.target.value)}
                className="text-xs font-semibold text-neutral-800 bg-transparent outline-none cursor-pointer pr-1"
              >
                <option value="mp3">MP3</option>
                <option value="wav">WAV</option>
              </select>
            </div>

            <Btn
              c="border border-neutral-300 bg-white hover:bg-neutral-50 text-neutral-700"
              onClick={undo}
              disabled={!hist.current.length}
            >
              Undo cut
            </Btn>
          </div>

          {/* Interactive waveform canvas */}
          <div className="mt-4 rounded-2xl border border-neutral-300/80 bg-white shadow-sm overflow-hidden">
            <div ref={box}>
              <canvas
                ref={cv}
                style={{ width: W, height: H, display: "block", touchAction: "none", cursor: "crosshair" }}
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
              />
            </div>
          </div>

          {/* Waveform timeline slider */}
          <input
            type="range"
            min="0"
            max={Math.max(0, dur - W / pps)}
            step="any"
            value={start}
            onChange={e => setStart(+e.target.value)}
            className="w-full mt-2 accent-indigo-600"
          />

          <p className="text-xs text-neutral-500 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>🖱️ <strong>Drag</strong> on waveform to select parts</span>
            <span>↔️ <strong>Drag edges</strong> to fine-tune</span>
            <span>🔍 <strong>Scroll</strong> to zoom</span>
            <span>↔️ <strong>Shift + scroll</strong> to pan</span>
          </p>

          {/* Selections / Parts list */}
          <div className="mt-8 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-neutral-800">
                Selected Parts <span className="text-sm font-normal text-neutral-500">({regs.length})</span>
              </h2>
              {regs.length > 0 && (
                <button
                  onClick={() => setRegs([])}
                  className="text-xs text-neutral-400 hover:text-red-600 transition font-medium"
                >
                  Clear All Parts
                </button>
              )}
            </div>

            {regs.length === 0 && (
              <div className="p-8 text-center rounded-2xl border border-dashed border-neutral-300 bg-neutral-50/50">
                <p className="text-neutral-500 text-sm font-medium">No parts selected yet.</p>
                <p className="text-xs text-neutral-400 mt-1">
                  Click and drag across any section of the waveform above to create a named audio clip.
                </p>
              </div>
            )}

            {regs.map((r, i) => (
              <div
                key={r.id}
                onClick={() => setSel(r.id)}
                className={
                  "flex flex-wrap items-center gap-3 p-3.5 pl-4 rounded-2xl border bg-white transition shadow-xs " +
                  (sel === r.id ? "border-indigo-500 ring-2 ring-indigo-100 shadow-sm" : "border-neutral-200 hover:border-neutral-300")
                }
              >
                <span className="text-xs font-bold text-neutral-400 w-5">{i + 1}</span>

                {/* Part Name Input */}
                <div className="flex items-center flex-1 min-w-[200px] border border-neutral-200 rounded-xl px-3 py-1.5 bg-neutral-50/60 focus-within:bg-white focus-within:border-indigo-500 transition">
                  <input
                    value={r.name}
                    onChange={e => upd(r.id, { name: e.target.value })}
                    placeholder="Part name"
                    className="flex-1 min-w-0 bg-transparent outline-none font-semibold text-neutral-800 text-sm"
                  />
                  <span className="text-neutral-400 text-xs font-mono font-medium ml-1">.{f}</span>
                </div>

                {/* Start & End precision inputs */}
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-neutral-400">Start</span>
                  <input
                    type="number"
                    step=".001"
                    defaultValue={r.s.toFixed(3)}
                    onBlur={e => upd(r.id, { s: clamp(+e.target.value, 0, r.e - 0.001) })}
                    className="w-20 border border-neutral-200 rounded-lg px-2 py-1 text-xs font-mono bg-white focus:border-indigo-500 outline-none"
                  />
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-neutral-400">End</span>
                  <input
                    type="number"
                    step=".001"
                    defaultValue={r.e.toFixed(3)}
                    onBlur={e => upd(r.id, { e: clamp(+e.target.value, r.s + 0.001, dur) })}
                    className="w-20 border border-neutral-200 rounded-lg px-2 py-1 text-xs font-mono bg-white focus:border-indigo-500 outline-none"
                  />
                </div>

                <span className="text-xs text-neutral-500 font-mono w-16 text-right font-medium">
                  {(r.e - r.s).toFixed(2)}s
                </span>

                {/* Actions per part */}
                <Btn
                  c="border border-neutral-200 bg-neutral-50 hover:bg-neutral-100 text-neutral-700 text-xs !py-1.5 !px-3"
                  onClick={() => play(r.s, r.e)}
                >
                  Play
                </Btn>

                {/* Single Download Button */}
                <Btn
                  c="bg-neutral-900 text-white hover:bg-neutral-800 text-xs !py-1.5 !px-3 shadow-xs"
                  onClick={() => one(i)}
                  title="Download this single clip"
                >
                  Download
                </Btn>

                {/* Cut Out button */}
                <Btn
                  c="border border-amber-300 text-amber-700 hover:bg-amber-50 text-xs !py-1.5 !px-3"
                  title="Remove this range from the audio itself"
                  onClick={() => cut(r.id)}
                >
                  Cut out
                </Btn>

                {/* Delete button */}
                <button
                  className="text-neutral-400 hover:text-red-500 px-2 text-base transition"
                  title="Remove this selection"
                  onClick={e => {
                    e.stopPropagation();
                    setRegs(rs => rs.filter(x => x.id !== r.id));
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          {/* Bulk Download options footer */}
          <div className="mt-10 p-6 rounded-3xl bg-neutral-50 border border-neutral-200 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              {/* ZIP Download */}
              <Btn
                c="bg-indigo-600 text-white hover:bg-indigo-500 !px-7 !py-3 shadow font-semibold text-sm flex items-center gap-2"
                disabled={!regs.length || !!busy}
                onClick={zip}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download Zip
              </Btn>

              {/* Single Auto Download */}
              <Btn
                c="border-2 border-neutral-900 text-neutral-900 hover:bg-neutral-900 hover:text-white !px-7 !py-3 font-semibold text-sm transition"
                disabled={!regs.length || !!busy}
                onClick={auto}
              >
                Single auto download
              </Btn>
            </div>

            <div className="text-sm font-medium text-neutral-500">
              {busy ? (
                <span className="inline-flex items-center gap-2 text-indigo-600 font-semibold animate-pulse">
                  <span className="w-2.5 h-2.5 rounded-full bg-indigo-600 animate-ping"></span>
                  {busy}
                </span>
              ) : regs.length > 0 ? (
                "Single auto download will save each part sequentially with a brief pause."
              ) : (
                "Create one or more parts on the waveform to enable downloads."
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
