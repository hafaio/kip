"use client";

import { type ReactElement, useState } from "react";
import { LuChevronRight, LuSearch, LuUserPlus } from "react-icons/lu";
import { findUserByUsername } from "../utils/friends";
import { useKip } from "../utils/store";
import type { ConnectRequest, Profile } from "../utils/types";
import { normalizeUsername, validateUsername } from "../utils/username";
import Avatar from "./avatar";
import { useAction } from "./dialog";
import RequestCard from "./request-card";
import Button from "./ui/button";
import FieldNote from "./ui/field-note";
import Input from "./ui/input";
import { Group, Row, Section } from "./ui/list";

// How to address an ask you've sent. A handle is the one thing only the by-handle
// route has, and `toName` is absent on anything written before it existed, so the
// label falls through what's actually there rather than rendering a bare "@".
function recipientLabel(request: ConnectRequest): {
  name: string;
  handle: string | null;
} {
  if (request.toName)
    return { name: request.toName, handle: request.toUsername || null };
  else if (request.toUsername)
    return { name: `@${request.toUsername}`, handle: null };
  else return { name: "Someone", handle: null };
}

export default function FriendsPanel(): ReactElement {
  const {
    profile,
    friends,
    incomingRequests,
    outgoingRequests,
    sendFriendRequest,
    cancelRequest,
    navigate,
  } = useKip();

  const run = useAction();
  const [username, setUsername] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<Profile | null>(null);

  // Finding someone is its own step, so you see WHO a handle belongs to before
  // asking them anything. Only possible because a handle that matches means the
  // profile is searchable, and so readable — the name is visible, never indexed:
  // `usernames/{handle}` still maps to a uid and nothing else, and nothing here
  // can be searched by name.
  async function find(): Promise<void> {
    const handle = normalizeUsername(username);
    if (!handle) return;
    const invalid = validateUsername(handle);
    if (invalid) {
      setFound(null);
      setStatus(invalid);
      return;
    }
    setBusy(true);
    setStatus(null);
    setFound(null);
    try {
      const target = await findUserByUsername(handle);
      // A private account reads exactly like one that was never there, which is
      // the point of the discovery gate.
      if (target) setFound(target);
      else setStatus("No kip user with that username.");
    } catch (error) {
      console.error(error);
      setStatus("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function send(target: Profile): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      const result = await sendFriendRequest(target.username);
      const messages: Record<typeof result, string> = {
        sent: `Request sent to ${target.displayName}.`,
        "not-found": "No kip user with that username.",
        "already-friends": "You're already friends.",
        self: "That's you!",
      };
      setStatus(messages[result]);
      if (result === "sent") {
        setUsername("");
        setFound(null);
      }
    } catch (error) {
      console.error(error);
      setStatus("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // Why there's nothing to send: the store re-checks all of this at send time,
  // but saying so up front beats offering a button that only ever refuses.
  const settled =
    found === null
      ? null
      : found.uid === profile?.uid
        ? "That's you"
        : friends.some((friend) => friend.uid === found.uid)
          ? "Already friends"
          : outgoingRequests.some((request) => request.to === found.uid)
            ? "Already asked"
            : null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-7">
      <Section title="Add a friend">
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <Input
              type="text"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                setFound(null);
                setStatus(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") find();
              }}
              placeholder="username"
              prefix="@"
            />
          </div>
          <Button onClick={find} disabled={busy} className="shrink-0">
            <LuSearch />
            Find
          </Button>
        </div>
        {found ? (
          <Group>
            <Row>
              <Avatar name={found.displayName} photoURL={found.photoURL} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[0.9375rem] font-medium">
                  {found.displayName || "Someone"}
                </span>
                <span className="truncate text-sm text-muted">
                  @{found.username}
                </span>
              </span>
              {settled ? (
                <span className="shrink-0 text-sm text-muted">{settled}</span>
              ) : (
                <Button
                  onClick={() => send(found)}
                  disabled={busy}
                  className="shrink-0"
                >
                  <LuUserPlus />
                  Send
                </Button>
              )}
            </Row>
          </Group>
        ) : null}
        {status ? <FieldNote>{status}</FieldNote> : null}
      </Section>

      {/* The same card Home shows, not a compact row of its own. Home caps its
          preview and sends you here for the rest, so this is the one screen that
          lists every ask — and it was the one dropping how they reached you and
          the way to turn that link off. A row can't carry either without a
          second copy of the revoke prompts, and those name consequences. */}
      {incomingRequests.length > 0 ? (
        <Section title="Requests">
          {incomingRequests.map((request) => (
            <RequestCard key={request.id} request={request} />
          ))}
        </Section>
      ) : null}

      {outgoingRequests.length > 0 ? (
        <Section title="Pending">
          <Group>
            {outgoingRequests.map((request) => {
              const { name, handle } = recipientLabel(request);
              return (
                <Row key={request.id}>
                  {/* The raw values, not the label: an initial should be a
                      letter, and the label may be an "@" handle. */}
                  <Avatar
                    name={request.toName || request.toUsername}
                    photoURL={request.toPhotoURL}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[0.9375rem]">{name}</span>
                    {handle ? (
                      <span className="truncate text-sm text-muted">
                        @{handle}
                      </span>
                    ) : null}
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() => run(() => cancelRequest(request))}
                    className="shrink-0"
                  >
                    Cancel
                  </Button>
                </Row>
              );
            })}
          </Group>
        </Section>
      ) : null}

      <Section
        title={friends.length > 0 ? `Friends (${friends.length})` : "Friends"}
      >
        {friends.length === 0 ? (
          <FieldNote>
            No friends yet. Add someone by their username above.
          </FieldNote>
        ) : (
          <Group>
            {friends.map((friend) => (
              <Row
                key={friend.uid}
                onClick={() => navigate({ kind: "person", id: friend.uid })}
                ariaLabel={friend.displayName}
              >
                <Avatar name={friend.displayName} photoURL={friend.photoURL} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[0.9375rem] font-medium">
                    {friend.displayName}
                  </span>
                  {friend.username ? (
                    <span className="truncate text-sm text-muted">
                      @{friend.username}
                    </span>
                  ) : null}
                </span>
                <LuChevronRight className="shrink-0 text-faint" />
              </Row>
            ))}
          </Group>
        )}
      </Section>
    </div>
  );
}
