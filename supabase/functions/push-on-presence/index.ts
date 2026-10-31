// push-on-presence — Supabase Edge Function.
// Called by a database webhook on presence_events INSERT. Sends an FCM
// push to every ADMIN's registered devices: "🟢 <name> is online".
// The Firebase service-account JSON is NOT an env secret: it lives in
// the PRIVATE Storage bucket "push-secrets" and is downloaded at
// runtime with the service-role key (auto-provided), so the key never
// transits any chat, form or log. PUSH_HOOK_SECRET is an env secret.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided automatically.

const HOOK_SECRET = Deno.env.get("PUSH_HOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

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

Deno.serve(async (req) => {
  try {
    if (HOOK_SECRET && req.headers.get("x-hook-secret") !== HOOK_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
    const payload = await req.json().catch(() => ({} as any));
    const userId: string | undefined = (payload as any)?.record?.user_id;
    if (!userId) {
      return Response.json({ ok: true, skipped: "no user_id" });
    }

    // Admins (from the admins table).
    const admins = await rest("admins?select=user_id");
    const adminIds: string[] = admins.map((a: any) => a.user_id);
    if (adminIds.length === 0) {
      return Response.json({ ok: true, skipped: "no admins" });
    }
    // Don't notify about an admin's own arrival.
    if (adminIds.includes(userId)) {
      return Response.json({ ok: true, skipped: "admin self" });
    }

    // Who came online?
    const prof = await rest(
      `profiles?id=eq.${userId}&select=display_name`,
    );
    const name = prof?.[0]?.display_name || "A player";

    // Admin devices.
    const inList = adminIds.map((i) => `"${i}"`).join(",");
    const rows = await rest(
      `user_push_tokens?user_id=in.(${inList})&select=token`,
    );
    const tokens: string[] = [...new Set(rows.map((r: any) => r.token))];
    if (tokens.length === 0) {
      return Response.json({ ok: true, skipped: "no admin tokens" });
    }

    const access = await googleAccessToken();
    const sa = await loadServiceAccount();
    let sent = 0;
    for (const token of tokens) {
      const res = await fetch(
        `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${access}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token,
              notification: {
                title: "🟢 Player online",
                body: `${name} is now online`,
              },
              android: {
                priority: "HIGH",
                notification: { channel_id: "winsquad_alerts" },
              },
            },
          }),
        },
      );
      if (res.ok) sent++;
    }
    return Response.json({ ok: true, sent, tokens: tokens.length });
  } catch (e) {
    return Response.json({ ok: false, error: String(e).slice(0, 300) }, {
      status: 500,
    });
  }
});
