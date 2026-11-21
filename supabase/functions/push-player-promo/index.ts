// push-player-promo — Supabase Edge Function.
// Sends a promotional FCM push to EVERY registered player device.
// Slots (POST {"slot": ...}):
//   daily — daily reward reminder      (cron 18:00 PKT)
//   peak  — peak-hours squad promo     (cron 20:00 PKT)
//   table — private-table promo        (cron 22:00 PKT)
//   ad    — extra ad batch: same real message texts, rotated by hour
// Every notification carries data.open_url = the Monetag Smartlink
// (zone 12313060 "WinSquad Player Notifications"), so a tap opens the
// ad in Chrome (APK v6 allows the uplcm.com host in urlFromIntent).
//
// Auth: header x-hook-secret must equal PROMO_HOOK_SECRET (same pattern
// as push-on-presence's PUSH_HOOK_SECRET). The Firebase service-account
// JSON lives in the PRIVATE Storage bucket "push-secrets" and is
// downloaded at runtime with the service-role key, so the key never
// transits any chat, form or log.
//
// FCM v1 has no multicast endpoint, so each token is sent individually
// through the v1 send endpoint (the same pattern push-on-presence uses).
// The FCM batch endpoint (https://fcm.googleapis.com/batch) was tried
// first but returns 404 for this project — verified 2026-11-21 with a
// valid access token, so it is not used. Sends run in small parallel
// groups so a large player base still finishes quickly; revisit if
// tokens ever exceed a few thousand.
//
// Safe test paths (never a blind send to all players):
//   dry run: POST {"dry_run": true, "slot": "daily"} -> token count +
//            the message that WOULD be sent; nothing is sent.
//   one-token live test: POST {"test_token": "<FCM token>"} -> sends
//            ONLY to that token (the owner's device).
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided automatically.

const HOOK_SECRET = Deno.env.get("PROMO_HOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const SMARTLINK_URL = "https://uplcm.com/4/12313060";

const MESSAGES: Record<string, { title: string; body: string }> = {
  daily: {
    title: "WinSquad",
    body: "Your daily reward is ready — open WinSquad and claim it!",
  },
  peak: {
    title: "WinSquad",
    body: "Peak hours! Play with your squad and win more money with your friends.",
  },
  table: {
    title: "WinSquad",
    body: "Your friends are waiting at a private table — join now and play together.",
  },
};

// The extra ad batch reuses the real texts; rotate by UTC hour so a
// day's ad sends don't all carry the same line.
const AD_ROTATION = ["daily", "peak", "table"] as const;

let SA: any = null;
async function loadServiceAccount(): Promise<any> {
  if (SA) return SA;
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/push-secrets/firebase-adminsdk.json`,
    {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    },
  );
  if (!res.ok) throw new Error(`service account fetch -> ${res.status}`);
  SA = await res.json();
  return SA;
}

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToBytes(pem: string): Uint8Array {
  const b64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function googleAccessToken(): Promise<string> {
  const SA = await loadServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: SA.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(SA.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  const jwt = `${header}.${claims}.${b64url(new Uint8Array(sig))}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const json = await res.json();
  if (!json.access_token) {
    throw new Error("oauth failed: " + JSON.stringify(json).slice(0, 200));
  }
  return json.access_token as string;
}

async function rest(path: string): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`rest ${path} -> ${res.status}`);
  return res.json();
}

// All registered player device tokens, deduped. Paged (PostgREST
// default page is 1000) so a large player base still works.
async function fetchAllTokens(): Promise<string[]> {
  const tokens: string[] = [];
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const rows = await rest(
      `user_push_tokens?select=token&order=created_at&limit=${PAGE}&offset=${offset}`,
    );
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) if (r?.token) tokens.push(r.token);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return [...new Set(tokens)];
}

function buildMessage(token: string, title: string, body: string): any {
  return {
    message: {
      token,
      notification: { title, body },
      data: { open_url: SMARTLINK_URL },
      android: {
        priority: "HIGH",
        notification: { channel_id: "winsquad_alerts" },
      },
    },
  };
}

// Send one chunk (<= 500 tokens) through the FCM HTTP v1 send endpoint,
// one request per token (same pattern as push-on-presence). Requests run
// in small parallel groups; failures are counted by FCM reason
// (e.g. NOT_FOUND for uninstalled apps). Tokens are never echoed back
// in any response.
async function sendChunk(
  access: string,
  projectId: string,
  tokens: string[],
  title: string,
  body: string,
): Promise<{
  sent: number;
  failed: number;
  failedByReason: Record<string, number>;
}> {
  const result: {
    sent: number;
    failed: number;
    failedByReason: Record<string, number>;
  } = { sent: 0, failed: 0, failedByReason: {} };
  const CONCURRENCY = 10;
  for (let i = 0; i < tokens.length; i += CONCURRENCY) {
    const group = tokens.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(
      group.map(async (token) => {
        try {
          const res = await fetch(
            `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${access}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(buildMessage(token, title, body)),
            },
          );
          if (res.ok) return "ok";
          const err = await res.json().catch(() => null);
          const status = (err as any)?.error?.status as string | undefined;
          return status || `http_${res.status}`;
        } catch {
          return "fetch_error";
        }
      }),
    );
    for (const o of outcomes) {
      if (o === "ok") {
        result.sent++;
      } else {
        result.failed++;
        result.failedByReason[o] = (result.failedByReason[o] || 0) + 1;
      }
    }
  }
  return result;
}

Deno.serve(async (req) => {
  try {
    if (HOOK_SECRET && req.headers.get("x-hook-secret") !== HOOK_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
    const payload = await req.json().catch(() => ({} as any));
    const slot = String((payload as any)?.slot ?? "");
    const dryRun = (payload as any)?.dry_run === true;
    const testToken =
      typeof (payload as any)?.test_token === "string"
        ? (payload as any).test_token.trim()
        : "";

    const valid = ["daily", "peak", "table", "ad"];
    if (!valid.includes(slot)) {
      return Response.json(
        { ok: false, error: "slot must be one of daily|peak|table|ad" },
        { status: 400 },
      );
    }
    const key =
      slot === "ad"
        ? AD_ROTATION[new Date().getUTCHours() % AD_ROTATION.length]
        : slot;
    const msg = MESSAGES[key];

    // Token set: a single test token, or every registered player device.
    const tokens = testToken ? [testToken] : await fetchAllTokens();

    // Dry run: report what WOULD be sent; send nothing, no OAuth at all.
    if (dryRun) {
      return Response.json({
        ok: true,
        dry_run: true,
        slot,
        resolved_text: key,
        title: msg.title,
        body: msg.body,
        open_url: SMARTLINK_URL,
        tokens: tokens.length,
        would_send: tokens.length,
      });
    }
    if (tokens.length === 0) {
      return Response.json({ ok: true, sent: 0, skipped: "no player tokens" });
    }

    const access = await googleAccessToken();
    const sa = await loadServiceAccount();
    let sent = 0;
    let failed = 0;
    const failedByReason: Record<string, number> = {};
    for (let i = 0; i < tokens.length; i += 500) {
      const chunk = tokens.slice(i, i + 500);
      const r = await sendChunk(access, sa.project_id, chunk, msg.title, msg.body);
      sent += r.sent;
      failed += r.failed;
      for (const [k, v] of Object.entries(r.failedByReason)) {
        failedByReason[k] = (failedByReason[k] || 0) + v;
      }
    }
    return Response.json({
      ok: true,
      slot,
      resolved_text: key,
      sent,
      failed,
      tokens: tokens.length,
      failedByReason,
      ...(testToken ? { test_only: true } : {}),
    });
  } catch (e) {
    return Response.json({ ok: false, error: String(e).slice(0, 300) }, {
      status: 500,
    });
  }
});
