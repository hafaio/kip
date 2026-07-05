"use client";

import { type ReactElement, useState } from "react";
import {
  LuCheck,
  LuCopy,
  LuGlobe,
  LuPowerOff,
  LuRotateCw,
} from "react-icons/lu";
import { useDialog } from "./dialog";
import Button from "./ui/button";
import IconButton from "./ui/icon-button";

// How much of the URL's tail is kept whole when the row runs out of room. Two
// links differ only in their token, so truncating at the end would leave every
// one of yours reading identically — the last few characters are what tells you
// which link you're looking at.
const TOKEN_TAIL = 6;

// Build the shareable URL. The token lives in the URL fragment (after #), which
// browsers never send to servers — so the capability isn't leaked via referrers
// or access logs.
function portalUrl(portalId: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}${base}/portal/#${portalId}`;
}

// Presentational control to mint / copy / regenerate / revoke a public link.
// The parent supplies the current token and the create/revoke actions, so the
// same control drives a listing link and a whole-profile link.
export default function ShareLink({
  portalId,
  createLabel,
  onCreate,
  onRevoke,
}: {
  portalId: string | null;
  createLabel: string;
  onCreate: () => Promise<void>;
  onRevoke: () => Promise<void>;
}): ReactElement {
  const { confirm } = useDialog();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function create(): Promise<void> {
    setBusy(true);
    try {
      await onCreate();
    } catch (error) {
      console.error(error);
    } finally {
      setBusy(false);
    }
  }

  async function regenerate(): Promise<void> {
    const ok = await confirm({
      title: "Regenerate the link?",
      body: "The current link stops working immediately; you'll get a fresh one.",
      confirmLabel: "Regenerate",
      tone: "danger",
    });
    if (ok) await create();
  }

  async function revoke(): Promise<void> {
    const ok = await confirm({
      title: "Turn off the public link?",
      body: "Anyone holding the link loses access. You can make a new one anytime.",
      confirmLabel: "Turn off",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await onRevoke();
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    if (!portalId) return;
    await navigator.clipboard.writeText(portalUrl(portalId));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  if (!portalId) {
    return (
      <Button variant="secondary" onClick={create} disabled={busy}>
        <LuGlobe />
        {createLabel}
      </Button>
    );
  }

  const url = portalUrl(portalId);
  return (
    <div className="flex items-center gap-1 rounded-2xl bg-surface-muted py-1.5 pl-3.5 pr-1.5">
      {/* Every control holds its size and the address gives way, so this is
          still one row at 390px — which is also why all three are icons. The
          head truncates against its own overflow while the tail rides beside
          it. */}
      <span className="flex min-w-0 flex-1 items-center text-sm text-muted">
        <span className="truncate">{url.slice(0, -TOKEN_TAIL)}</span>
        <span className="shrink-0">{url.slice(-TOKEN_TAIL)}</span>
      </span>
      <IconButton label={copied ? "Copied" : "Copy link"} onClick={copy}>
        {copied ? (
          <LuCheck size={17} className="text-success" />
        ) : (
          <LuCopy size={17} />
        )}
      </IconButton>
      <IconButton label="Regenerate link" onClick={regenerate} disabled={busy}>
        <LuRotateCw size={17} />
      </IconButton>
      <IconButton
        label="Turn off link"
        variant="danger"
        onClick={revoke}
        disabled={busy}
      >
        <LuPowerOff size={17} />
      </IconButton>
    </div>
  );
}
