// Local HTTPS without any external service.
//
// Browsers only give web pages full-rate pen input (and only let a site be
// installed as an app) over https. On a home network there is no public
// certificate, so the server creates its own small certificate authority (CA)
// once, and the tablet trusts it by installing ca.crt one time.
//
// The server certificate covers every address the server has been reached by
// (LAN IPs, casaos.local, ...). When a new one shows up, a fresh certificate is
// issued from the same CA and swapped in live, so the tablet never has to
// reinstall anything.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import forge from 'node-forge';

const MAX_HOSTS = 40;
const LEAF_DAYS = 397; // browsers reject server certificates valid for longer than this
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function newKeyPair() {
  // Node's native RSA is fast even on small ARM boards; forge's pure-JS keygen is not.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey: forge.pki.privateKeyFromPem(privateKey), publicKey: forge.pki.publicKeyFromPem(publicKey) };
}

function issue({ publicKey, subject, issuer, signingKey, days, extensions }) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`;
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600e3);
  cert.validity.notAfter = new Date(Date.now() + days * 24 * 3600e3);
  cert.setSubject(subject);
  cert.setIssuer(issuer);
  cert.setExtensions(extensions);
  cert.sign(signingKey, forge.md.sha256.create());
  return cert;
}

export function normalizeHost(h) {
  if (!h) return null;
  h = String(h).trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[')) h = h.slice(1, h.indexOf(']'));
  else if (h.split(':').length === 2) h = h.split(':')[0]; // strip :port (not IPv6)
  if (net.isIP(h) || HOST_RE.test(h)) return h;
  return null;
}

export async function createCertManager(dir, initialHosts = []) {
  await fs.mkdir(dir, { recursive: true });
  const file = name => path.join(dir, name);
  const read = name => fs.readFile(file(name), 'utf8').catch(() => null);

  // --- CA (made once, valid 10 years) ---
  let caKeyPem = await read('ca-key.pem');
  let caPem = await read('ca.crt');
  if (!caKeyPem || !caPem) {
    const keys = newKeyPair();
    const name = [
      { name: 'commonName', value: `InkVault Local CA ${crypto.randomBytes(3).toString('hex')}` },
      { name: 'organizationName', value: 'InkVault (self-hosted)' },
    ];
    const ca = issue({
      publicKey: keys.publicKey, subject: name, issuer: name, signingKey: keys.privateKey, days: 3650,
      extensions: [
        { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
        { name: 'subjectKeyIdentifier' },
      ],
    });
    caKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
    caPem = forge.pki.certificateToPem(ca);
    await fs.writeFile(file('ca-key.pem'), caKeyPem, { mode: 0o600 });
    await fs.writeFile(file('ca.crt'), caPem);
  }
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  const caCert = forge.pki.certificateFromPem(caPem);

  // --- hosts the certificate must cover ---
  const hosts = new Set(['localhost', '127.0.0.1']);
  for (const h of JSON.parse((await read('hosts.json')) || '[]')) hosts.add(h);
  for (const h of initialHosts) { const n = normalizeHost(h); if (n) hosts.add(n); }

  // --- server certificate ---
  let keyPem = await read('server-key.pem');
  let certPem = await read('server.crt');
  const covers = pem => {
    try {
      const c = forge.pki.certificateFromPem(pem);
      if (c.validity.notAfter - Date.now() < 30 * 24 * 3600e3) return false;
      const san = c.getExtension('subjectAltName')?.altNames || [];
      const have = new Set(san.map(a => (a.type === 7 ? a.ip : a.value)));
      return [...hosts].every(h => have.has(h));
    } catch {
      return false;
    }
  };

  async function reissue() {
    const keys = keyPem ? { privateKey: forge.pki.privateKeyFromPem(keyPem) } : newKeyPair();
    const publicKey = keys.publicKey || forge.pki.setRsaPublicKey(keys.privateKey.n, keys.privateKey.e);
    const cert = issue({
      publicKey,
      subject: [{ name: 'commonName', value: [...hosts].find(h => !net.isIP(h) && h !== 'localhost') || [...hosts].pop() }],
      issuer: caCert.subject.attributes,
      signingKey: caKey,
      days: LEAF_DAYS,
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [...hosts].map(h => (net.isIP(h) ? { type: 7, ip: h } : { type: 2, value: h })) },
      ],
    });
    keyPem = forge.pki.privateKeyToPem(keys.privateKey);
    certPem = forge.pki.certificateToPem(cert);
    await fs.writeFile(file('server-key.pem'), keyPem, { mode: 0o600 });
    await fs.writeFile(file('server.crt'), certPem);
    await fs.writeFile(file('hosts.json'), JSON.stringify([...hosts], null, 2));
  }

  if (!keyPem || !certPem || !covers(certPem)) await reissue();

  const listeners = new Set();
  let pending = Promise.resolve();

  return {
    caPem,
    caName: caCert.subject.getField('CN').value,
    get context() { return { key: keyPem, cert: `${certPem}${caPem}` }; },
    hosts: () => [...hosts],
    onChange(fn) { listeners.add(fn); },
    // Called with the Host header of incoming requests; learns new addresses.
    addHost(raw) {
      const h = normalizeHost(raw);
      if (!h || hosts.has(h) || hosts.size >= MAX_HOSTS) return;
      hosts.add(h);
      pending = pending.then(reissue).then(() => { for (const fn of listeners) fn(this.context); }).catch(e => console.error('cert reissue failed', e));
    },
  };
}
