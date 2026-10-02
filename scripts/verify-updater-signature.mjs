import { createHash, createPublicKey, verify } from 'node:crypto';
import { Buffer } from 'node:buffer';

function decode(value) {
  const encoded = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error('Invalid updater signature encoding');
  }
  return Buffer.from(encoded, 'base64');
}

// Tauri wraps a Minisign public key/signature in base64. Verify both the hashed
// payload and signed comment with Node's Ed25519 implementation. Format:
// https://jedisct1.github.io/minisign/#signature-format
export function verifyUpdaterSignature(bytes, encodedSignature, encodedPublicKey, version) {
  const publicLines = decode(encodedPublicKey).toString('utf8').trim().split(/\r?\n/);
  const signatureLines = decode(encodedSignature).toString('utf8').trim().split(/\r?\n/);
  if (publicLines.length !== 2 || signatureLines.length !== 4 ||
      !publicLines[0].startsWith('untrusted comment: ') ||
      !signatureLines[0].startsWith('untrusted comment: ') ||
      !signatureLines[2].startsWith('trusted comment: ')) {
    throw new Error('Invalid updater signature format');
  }
  const publicBytes = decode(publicLines[1]);
  const signatureBytes = decode(signatureLines[1]);
  const globalSignature = decode(signatureLines[3]);
  if (publicBytes.length !== 42 || publicBytes.subarray(0, 2).toString() !== 'Ed' ||
      signatureBytes.length !== 74 || signatureBytes.subarray(0, 2).toString() !== 'ED' ||
      globalSignature.length !== 64 || !publicBytes.subarray(2, 10).equals(signatureBytes.subarray(2, 10))) {
    throw new Error('Invalid updater signature algorithm or key');
  }
  const key = createPublicKey({
    // RFC 8410 SubjectPublicKeyInfo header for a raw Ed25519 public key.
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicBytes.subarray(10)]),
    format: 'der', type: 'spki',
  });
  const signature = signatureBytes.subarray(10);
  const comment = signatureLines[2].slice('trusted comment: '.length);
  if (!verify(null, createHash('blake2b512').update(bytes).digest(), key, signature) ||
      !verify(null, Buffer.concat([signature, Buffer.from(comment)]), key, globalSignature)) {
    throw new Error('Updater signature verification failed');
  }
  const signedVersion = comment.split('\t').find(field => field.startsWith('version:'))?.slice(8);
  if (!signedVersion || signedVersion.replace(/^v/, '') !== version.replace(/^v/, '')) {
    throw new Error('Updater signed version does not match the release');
  }
}
