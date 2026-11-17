import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { combinedText, formatUsd, isImage, naturalOrder, sendImage, withRetries, zipOfTexts, type Item } from "./batch.ts";

const concurrency = 4;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Entry = Item & { file: File; thumb: string };

export function App() {
  const [phase, setPhase] = useState<"checking" | "login" | "ready">("checking");
  const [ocrReady, setOcrReady] = useState(true);

  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then((health: { ocrReady?: boolean }) => setOcrReady(health.ocrReady !== false))
      .catch(() => {});
    fetch("/api/me").then(
      (response) => setPhase(response.ok ? "ready" : "login"),
      () => setPhase("login"),
    );
  }, []);

  if (phase === "checking") return null;
  if (phase === "login") return <Login onDone={() => setPhase("ready")} />;
  return <Reader ocrReady={ocrReady} />;
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
      <h1>Bulk to text</h1>
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

function Reader({ ocrReady }: { ocrReady: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [dragging, setDragging] = useState(false);
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
    setSkipped((count) => count + files.length - images.length);
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

  function startOver() {
    generation.current++;
    queue.current = [];
    active.current = 0;
    for (const entry of entries) URL.revokeObjectURL(entry.thumb);
    setEntries([]);
    setSkipped(0);
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
      <header>
        <h1>Bulk to text</h1>
        <p className="muted">Drop images here and get all the text out of each one.</p>
      </header>

      {!ocrReady ? (
        <p className="notice">Reading text isn't set up yet. Ask Peyton to add the API key.</p>
      ) : (
        <section className={`drop ${dragging ? "dragging" : ""}`} aria-label="Add images">
          <p>Drop images or a whole folder here</p>
          <p className="muted small">JPG, PNG, WebP or HEIC. As many as you like.</p>
          <div className="buttons">
            <label className="button primary">
              Choose images
              <input type="file" multiple accept="image/*,.heic,.heif" hidden onChange={(event) => {
                add([...(event.target.files ?? [])].map((file) => ({ file, name: file.name })));
                event.target.value = "";
              }} />
            </label>
            <label className="button folder">
              Choose a folder
              <input type="file" hidden {...{ webkitdirectory: "" }} onChange={(event) => {
                add([...(event.target.files ?? [])].map((file) => ({ file, name: file.webkitRelativePath || file.name })));
                event.target.value = "";
              }} />
            </label>
          </div>
        </section>
      )}

      {skipped > 0 && <p className="muted small">Skipped {skipped} {skipped === 1 ? "file that isn't an image" : "files that aren't images"}.</p>}

      {entries.length > 0 && (
        <section className="summary" aria-live="polite">
          <div className="progress-line">
            <strong data-testid="progress">
              {finished} of {entries.length} {working ? "read so far" : "done"}
            </strong>
            <span className="muted" data-testid="total-cost">Cost so far: about {formatUsd(spent)}</span>
          </div>
          <progress max={entries.length} value={finished} />
          {failed > 0 && !working && <p className="error">{failed} could not be read.</p>}
          <div className="buttons">
            <button className="primary" disabled={!finished} onClick={() => download("all-text.txt", combinedText(entries), "text/plain;charset=utf-8")}>
              Download all as one .txt
            </button>
            <button disabled={!done} onClick={() => download("texts.zip", zipOfTexts(entries) as BlobPart, "application/zip")}>
              Download .zip (one .txt per image)
            </button>
            {failed > 0 && !working && <button onClick={retryFailed}>Retry failed</button>}
            <button className="quiet" onClick={startOver}>Start over</button>
          </div>
        </section>
      )}

      <ol className="results">
        {entries.map((entry) => (
          <Result key={entry.id} entry={entry} />
        ))}
      </ol>
    </main>
  );
}

const statusLabel = { waiting: "Waiting", reading: "Reading…", done: "Done", failed: "Failed" };

function Result({ entry }: { entry: Entry }) {
  const [copied, setCopied] = useState(false);
  const [thumbBroken, setThumbBroken] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(entry.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <li className={`result ${entry.status}`} data-testid="result">
      <div className="thumb">
        {thumbBroken ? <span className="no-preview">No preview</span> : <img src={entry.thumb} alt="" loading="lazy" onError={() => setThumbBroken(true)} />}
      </div>
      <div className="body">
        <div className="title">
          <span className="name">{entry.name}</span>
          <span className={`status ${entry.status}`}>{statusLabel[entry.status]}</span>
          {entry.costUsd !== null && <span className="muted small">{formatUsd(entry.costUsd)}</span>}
        </div>
        {entry.status === "done" && (entry.text ? <pre className="text">{entry.text}</pre> : <p className="muted">No text found.</p>)}
        {entry.status === "failed" && <p className="error">{entry.error}</p>}
        {entry.status === "done" && entry.text && (
          <button className="small-button" onClick={copy}>
            {copied ? "Copied" : "Copy text"}
          </button>
        )}
      </div>
    </li>
  );
}
