const DEFAULT_TTL_MS = 15 * 60 * 1000;
const NONCE_PRUNE_INTERVAL = 50;

function createApprovalSigner(config) {
  const ttlMs = typeof config?.ttlMs === "number" && config.ttlMs > 0
    ? config.ttlMs
    : DEFAULT_TTL_MS;
  const rawKey = config?.key != null ? config.key : null;
  const onDegraded = typeof config?.onDegraded === "function" ? config.onDegraded : null;
  const seenNonces = new Map();
  let pruneCounter = 0;
  let keyPromise = null;
  let degraded = false;

  function notifyDegraded(reason) {
    if (degraded) return;
    degraded = true;
    if (onDegraded) {
      try {
        onDegraded({ reason });
      } catch (_) {
        // ignore
      }
    }
  }

  async function getCryptoKey() {
    if (keyPromise) return keyPromise;
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle || typeof subtle.importKey !== "function") {
      notifyDegraded("no_webcrypto");
      keyPromise = Promise.resolve(null);
      return keyPromise;
    }

    try {
      const bytes = await resolveKeyBytes(rawKey);
      keyPromise = subtle.importKey(
        "raw",
        bytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"]
      );
    } catch (err) {
      notifyDegraded("import_failed");
      keyPromise = Promise.resolve(null);
    }

    return keyPromise;
  }

  async function sign(payload) {
    const base = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    const meta = {
      v: 1,
      nonce: randomId(),
      issuedAt: Date.now(),
      ttlMs
    };

    const key = await getCryptoKey();
    if (!key) {
      return { ...base, _meta: { ...meta, sig: null, unsigned: true } };
    }

    const signedMeta = { ...meta };
    const sig = await hmacSign(key, canonicalize({ ...base, _meta: signedMeta }));
    return { ...base, _meta: { ...signedMeta, sig } };
  }

  async function verify(token) {
    if (!token || typeof token !== "object" || Array.isArray(token)) {
      return { ok: false, reason: "shape" };
    }

    const meta = token._meta;
    if (!meta || typeof meta !== "object") {
      return { ok: false, reason: "missing_meta" };
    }

    if (typeof meta.issuedAt !== "number" || typeof meta.ttlMs !== "number") {
      return { ok: false, reason: "missing_meta" };
    }

    if (Date.now() - meta.issuedAt > meta.ttlMs) {
      return { ok: false, reason: "expired" };
    }

    if (typeof meta.nonce !== "string" || !meta.nonce) {
      return { ok: false, reason: "missing_nonce" };
    }

    if (seenNonces.has(meta.nonce)) {
      return { ok: false, reason: "replay" };
    }

    if (meta.unsigned === true) {
      const key = await getCryptoKey();
      if (key) {
        return { ok: false, reason: "unsigned_but_key_available" };
      }
      rememberNonce(meta);
      return { ok: true, unsigned: true };
    }

    if (typeof meta.sig !== "string" || !meta.sig) {
      return { ok: false, reason: "missing_sig" };
    }

    const key = await getCryptoKey();
    if (!key) {
      return { ok: false, reason: "no_webcrypto" };
    }

    const { sig, ...metaWithoutSig } = meta;
    const ok = await hmacVerify(
      key,
      sig,
      canonicalize({ ...token, _meta: metaWithoutSig })
    );

    if (!ok) {
      return { ok: false, reason: "sig" };
    }

    rememberNonce(meta);
    return { ok: true };
  }

  function rememberNonce(meta) {
    seenNonces.set(meta.nonce, meta.issuedAt + meta.ttlMs);
    pruneCounter++;
    if (pruneCounter >= NONCE_PRUNE_INTERVAL) {
      pruneCounter = 0;
      pruneExpired(seenNonces);
    }
  }

  return { sign, verify, _state: { seenNonces } };
}

function stripSigningMeta(token) {
  if (!token || typeof token !== "object" || Array.isArray(token)) {
    return token;
  }
  const { _meta, ...rest } = token;
  return rest;
}

function pruneExpired(seenNonces) {
  const now = Date.now();
  for (const [nonce, expiresAt] of seenNonces) {
    if (expiresAt <= now) {
      seenNonces.delete(nonce);
    }
  }
}

async function resolveKeyBytes(rawKey) {
  if (rawKey instanceof Uint8Array) {
    return rawKey;
  }
  if (typeof rawKey === "string" && rawKey.length > 0) {
    return new TextEncoder().encode(rawKey);
  }
  const random = new Uint8Array(32);
  globalThis.crypto.getRandomValues(random);
  return random;
}

async function hmacSign(key, data) {
  const sig = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return bytesToBase64url(new Uint8Array(sig));
}

async function hmacVerify(key, sig, data) {
  try {
    return await globalThis.crypto.subtle.verify(
      "HMAC",
      key,
      base64urlToBytes(sig),
      new TextEncoder().encode(data)
    );
  } catch (_) {
    return false;
  }
}

function canonicalize(value) {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v).sort().reduce((acc, k) => {
        acc[k] = v[k];
        return acc;
      }, {});
    }
    return v;
  });
}

function randomId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytesToBase64url(bytes);
}

function bytesToBase64url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = globalThis.btoa ? globalThis.btoa(binary) : nodeBtoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = globalThis.atob ? globalThis.atob(padded) : nodeAtob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function nodeBtoa(binary) {
  return Buffer.from(binary, "binary").toString("base64");
}

function nodeAtob(base64) {
  return Buffer.from(base64, "base64").toString("binary");
}

export { createApprovalSigner, stripSigningMeta };
