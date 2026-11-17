import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { formatKroner, isImage, naturalOrder, sendImage, withRetries, zipOfTexts, type Item } from "./batch.ts";
import { asText, build, collect, fileName, formats, mimeTypes, type Format } from "./export.ts";

const concurrency = 4;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Entry = Item & { file: File; thumb: string };

export function App() {
  const [phase, setPhase] = useState<"checking" | "login" | "ready">("checking");
  const [ocrReady, setOcrReady] = useState(true);
  const [usdToDkk, setUsdToDkk] = useState(6.9);

  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then((health: { ocrReady?: boolean; usdToDkk?: number }) => {
        setOcrReady(health.ocrReady !== false);
        if (typeof health.usdToDkk === "number") setUsdToDkk(health.usdToDkk);
      })
      .catch(() => {});
    fetch("/api/me").then(
      (response) => setPhase(response.ok ? "ready" : "login"),
      () => setPhase("login"),
    );
  }, []);

  if (phase === "checking") return null;
  if (phase === "login") return <Login onDone={() => setPhase("ready")} />;
  return <Reader ocrReady={ocrReady} usdToDkk={usdToDkk} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const response = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) }).catch(() => undefined);
    setBusy(false);
    if (response?.ok) return onDone();
    const body = (await response?.json().catch(() => ({}))) as { error?: string } | undefined;
    setError(body?.error ?? "Could not reach the server.");
  }

  return (
    <main className="login">
      <h1>Bulk to Text</h1>
      <p className="muted">Get the text out of many images at once.</p>
      <form onSubmit={submit}>
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus />
        <button className="primary" type="submit" disabled={busy || !password}>
          {busy ? "Logging in…" : "Log in"}
        </button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </main>
  );
}

/** Folders dropped on the page: walks them and keeps the path, so "scans/page 1.jpg" stays apart from "old/page 1.jpg". */
async function filesFromDrop(transfer: DataTransfer): Promise<{ file: File; name: string }[]> {
  const entries = [...transfer.items].map((item) => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => !!entry);
  if (!entries.length) return [...transfer.files].map((file) => ({ file, name: file.name }));
  const found: { file: File; name: string }[] = [];
  async function walk(entry: FileSystemEntry): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      found.push({ file, name: entry.fullPath.replace(/^\//, "") });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries hands back at most about 100 at a time.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  }
  for (const entry of entries) await walk(entry);
  return found;
}

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function Reader({ ocrReady, usdToDkk }: { ocrReady: boolean; usdToDkk: number }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [skippedFiles, setSkippedFiles] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [viewing, setViewing] = useState<Entry | null>(null);
  const queue = useRef<Entry[]>([]);
  const active = useRef(0);
  const nextId = useRef(0);
  // Results for images removed by "Start over" are ignored.
  const generation = useRef(0);

  const update = (id: string, change: Partial<Item>) => setEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)));

  const pump = useCallback(() => {
    while (active.current < concurrency && queue.current.length) {
      const entry = queue.current.shift()!;
      const started = generation.current;
      active.current++;
      update(entry.id, { status: "reading", error: "" });
      withRetries(() => sendImage(entry.file, entry.name), sleep).then((answer) => {
        if (started !== generation.current) return;
        active.current--;
        const result: Partial<Item> = answer.ok ? { status: "done", text: answer.text } : { status: "failed", error: answer.error };
        // A retried image keeps what its earlier tries cost.
        setEntries((current) =>
          current.map((item) => (item.id === entry.id ? { ...item, ...result, costUsd: answer.spent === null ? item.costUsd : (item.costUsd ?? 0) + answer.spent } : item)),
        );
        pump();
      });
    }
  }, []);

  function add(files: { file: File; name: string }[]) {
    if (!ocrReady) return;
    const images = files.filter(({ file }) => isImage(file));
    const notImages = files.filter(({ file }) => !isImage(file)).map(({ name }) => name);
    if (notImages.length) setSkippedFiles((current) => [...current, ...notImages]);
    const added: Entry[] = images
      .map(({ file, name }) => ({
        id: String(nextId.current++),
        name,
        file,
        thumb: URL.createObjectURL(file),
        status: "waiting" as const,
        text: "",
        error: "",
        costUsd: null,
      }))
      .sort(naturalOrder);
    setEntries((current) => [...current, ...added].sort(naturalOrder));
    queue.current.push(...added);
    queue.current.sort(naturalOrder);
    pump();
  }

  function retryFailed() {
    const failed = entries.filter((entry) => entry.status === "failed");
    for (const entry of failed) update(entry.id, { status: "waiting", error: "" });
    queue.current.push(...failed);
    pump();
  }

  function retry(entry: Entry) {
    update(entry.id, { status: "waiting", error: "" });
    queue.current.push(entry);
    pump();
  }

  function startOver() {
    generation.current++;
    queue.current = [];
    active.current = 0;
    for (const entry of entries) URL.revokeObjectURL(entry.thumb);
    setEntries([]);
    setSkippedFiles([]);
  }

  async function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    add(await filesFromDrop(event.dataTransfer));
  }

  const finished = entries.filter((entry) => entry.status === "done" || entry.status === "failed").length;
  const failed = entries.filter((entry) => entry.status === "failed").length;
  const done = entries.filter((entry) => entry.status === "done").length;
  const spent = entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
  const working = finished < entries.length;
  const skipped = skippedFiles.length;
  const skippedNote = skipped > 0 && `Skipped ${skipped} ${skipped === 1 ? "file that isn't an image" : "files that aren't images"}.`;

  return (
    <main
      className="reader"
      onDragOver={(event) => {
        event.preventDefault();
        if (ocrReady) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="masthead">
        <h1>Bulk to Text</h1>
        <p className="muted">Drop images here and get all the text out of each one.</p>
      </header>

      {!ocrReady ? (
        <p className="notice">Reading text isn't set up yet. Ask Peyton to add the API key.</p>
      ) : (
        <Picker dragging={dragging} compact={entries.length > 0} onFiles={add} />
      )}

      {skippedNote && entries.length === 0 && <p className="muted small">{skippedNote}</p>}

      {entries.length > 0 && (
        <section className="summary" aria-label="Progress and downloads">
          <div className="summary-inner">
            <div className="tally" aria-live="polite">
              <strong data-testid="progress">
                {finished} of {entries.length} {working ? "read so far" : "done"}
              </strong>
              <span className="meta">
                <span data-testid="total-cost">Cost so far: {formatKroner(spent, usdToDkk)}</span>
                {skippedNote && <span>{skippedNote}</span>}
                {failed > 0 && !working && <span className="error">{failed} could not be read.</span>}
              </span>
            </div>
            <div className="actions">
              <DownloadAll disabled={!done} make={() => collect(entries, skippedFiles)} />
              <CopyButton className="secondary" label="Copy all" text={() => asText(collect(entries, skippedFiles))} disabled={!done} />
              <button className="link" disabled={!done} onClick={() => download("texts.zip", zipOfTexts(entries) as BlobPart, "application/zip")}>
                One text file per image (.zip)
              </button>
              {failed > 0 && !working && (
                <button className="link" onClick={retryFailed}>
                  Retry failed
                </button>
              )}
              <button className="link muted" onClick={startOver}>
                Start over
              </button>
            </div>
          </div>
          <progress max={entries.length} value={finished} aria-label="Images read" />
        </section>
      )}

      <ol className="results">
        {entries.map((entry) => (
          <Result key={entry.id} entry={entry} usdToDkk={usdToDkk} onRetry={() => retry(entry)} onView={() => setViewing(entry)} />
        ))}
      </ol>

      {viewing && <Viewer entry={viewing} onClose={() => setViewing(null)} />}
    </main>
  );
}

function Picker({ dragging, compact, onFiles }: { dragging: boolean; compact: boolean; onFiles: (files: { file: File; name: string }[]) => void }) {
  const images = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  return (
    <section className={`drop${dragging ? " dragging" : ""}${compact ? " compact" : ""}`} aria-label="Add images">
      <p className="drop-title">Drop images or a whole folder here</p>
      <p className="muted small">JPG, PNG, WebP or HEIC. As many as you like.</p>
      <div className="drop-actions">
        <button className="primary" onClick={() => images.current?.click()}>
          Choose images
        </button>
        <button className="link folder" onClick={() => folder.current?.click()}>
          or choose a folder
        </button>
      </div>
      <input ref={images} type="file" multiple accept="image/*,.heic,.heif" hidden onChange={(event) => {
        onFiles([...(event.target.files ?? [])].map((file) => ({ file, name: file.name })));
        event.target.value = "";
      }} />
      <input ref={folder} type="file" hidden {...{ webkitdirectory: "" }} onChange={(event) => {
        onFiles([...(event.target.files ?? [])].map((file) => ({ file, name: file.webkitRelativePath || file.name })));
        event.target.value = "";
      }} />
    </section>
  );
}

function DownloadAll({ disabled, make }: { disabled: boolean; make: () => ReturnType<typeof collect> }) {
  const [format, setFormat] = useState<Format>("docx");
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  async function save() {
    setState("busy");
    try {
      download(fileName(format), await build(format, make()), mimeTypes[format]);
      setState("idle");
    } catch {
      setState("failed");
    }
  }
  return (
    <div className="download">
      <button className="primary" disabled={disabled || state === "busy"} onClick={save}>
        {state === "busy" ? "Making the file…" : state === "failed" ? "Didn't work. Try again" : "Download all"}
      </button>
      <select aria-label="File type" value={format} disabled={disabled} onChange={(event) => setFormat(event.target.value as Format)}>
        {formats.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

function CopyButton({ label, text, className, disabled }: { label: string; text: () => string; className?: string; disabled?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "blocked">("idle");
  async function copy() {
    const copied = await navigator.clipboard.writeText(text()).then(() => true, () => false);
    setState(copied ? "copied" : "blocked");
    setTimeout(() => setState("idle"), 1800);
  }
  return (
    <button className={className} disabled={disabled} onClick={copy}>
      {state === "copied" ? "Copied" : state === "blocked" ? "Copy isn't allowed here" : label}
    </button>
  );
}

function Viewer({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => dialog.current?.showModal(), []);
  return (
    <dialog
      ref={dialog}
      className="viewer"
      aria-label={entry.name}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <div className="viewer-bar">
        <span className="name">{entry.name}</span>
        <button className="link" onClick={() => dialog.current?.close()} autoFocus>
          Close
        </button>
      </div>
      <img src={entry.thumb} alt={entry.name} />
    </dialog>
  );
}

const statusLabel = { waiting: "Waiting", reading: "Reading…", done: "Done", failed: "Failed" };

function Result({ entry, usdToDkk, onRetry, onView }: { entry: Entry; usdToDkk: number; onRetry: () => void; onView: () => void }) {
  const [thumbBroken, setThumbBroken] = useState(false);

  return (
    <li className={`result ${entry.status}`} data-testid="result">
      {thumbBroken ? (
        <div className="thumb">
          <span className="no-preview">No preview</span>
        </div>
      ) : (
        <button className="thumb" onClick={onView} aria-label={`Show ${entry.name} larger`}>
          <img src={entry.thumb} alt="" loading="lazy" onError={() => setThumbBroken(true)} />
        </button>
      )}
      <div className="body">
        <div className="title">
          <span className="name">{entry.name}</span>
          <span className={`status ${entry.status}`}>{statusLabel[entry.status]}</span>
          {entry.costUsd !== null && <span className="cost">{formatKroner(entry.costUsd, usdToDkk)}</span>}
          <span className="title-actions">
            {entry.status === "done" && entry.text && <CopyButton className="link" label="Copy" text={() => entry.text} />}
            {entry.status === "failed" && (
              <button className="link" onClick={onRetry}>
                Retry
              </button>
            )}
          </span>
        </div>
        {entry.status === "done" && (entry.text ? <pre className="text">{entry.text}</pre> : <p className="muted small">No text found.</p>)}
        {entry.status === "failed" && <p className="error small">{entry.error}</p>}
      </div>
    </li>
  );
}
