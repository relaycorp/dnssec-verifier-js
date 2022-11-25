import type { KeyObject } from 'node:crypto';
import { createPublicKey } from 'node:crypto';

import { toBufferBE } from 'bigint-buffer';

import { getIntegerByteLength } from '../integers';
import { DnssecAlgorithm } from '../../DnssecAlgorithm';
import { DnssecError } from '../../DnssecError';

import { ECDSA_CURVE_LENGTH } from './curves';

export function serialisePublicKey(publicKey: KeyObject, dnssecAlgorithm: DnssecAlgorithm): Buffer {
  switch (dnssecAlgorithm) {
    case DnssecAlgorithm.RSASHA1:
    case DnssecAlgorithm.RSASHA256:
    case DnssecAlgorithm.RSASHA512: {
      return serialiseRsaPublicKey(publicKey);
    }
    case DnssecAlgorithm.ECDSAP256SHA256:
    case DnssecAlgorithm.ECDSAP384SHA384: {
      return serialiseEcDsaPublicKey(publicKey);
    }
    case DnssecAlgorithm.ED25519:
    case DnssecAlgorithm.ED448: {
      return serialiseEdDsaPublicKey(publicKey);
    }
    default: {
      throw new Error(`Unsupported DNSSEC algorithm (${dnssecAlgorithm})`);
    }
  }
}

function serialiseRsaPublicKey(publicKey: KeyObject): Buffer {
  const algorithm = publicKey.asymmetricKeyType!;
  if (!algorithm.startsWith('rsa')) {
    throw new Error(`Requested serialisation of RSA key but got ${algorithm} key`);
  }

  const exponent = publicKey.asymmetricKeyDetails!.publicExponent!;
  const exponentBuffer = toBufferBE(exponent, getIntegerByteLength(exponent));
  const exponentLengthPrefix = serialiseRsaExponentPrefix(exponentBuffer);

  const keyJwt = publicKey.export({ format: 'jwk' });
  const modulusBuffer = Buffer.from(keyJwt.n!, 'base64');

  return Buffer.concat([exponentLengthPrefix, exponentBuffer, modulusBuffer]);
}

function serialiseRsaExponentPrefix(exponent: Buffer): Buffer {
  const exponentLength = exponent.byteLength;
  let prefix: Buffer;
  if (exponentLength < 256) {
    // Length fits in one octet
    prefix = Buffer.from([exponentLength]);
  } else {
    // We'll need two octets to represent the length
    prefix = Buffer.allocUnsafe(3);
    prefix.writeUInt8(0, 0);
    prefix.writeUInt16BE(exponentLength, 1);
  }
  return prefix;
}

function serialiseEcDsaPublicKey(publicKey: KeyObject): Buffer {
  const algorithm = publicKey.asymmetricKeyType!;
  if (algorithm !== 'ec') {
    throw new Error(`Requested serialisation of ECDSA key but got ${algorithm} key`);
  }

  const keyJwt = publicKey.export({ format: 'jwk' });
  const xBuffer = Buffer.from(keyJwt.x!, 'base64url');
  const yBuffer = Buffer.from(keyJwt.y!, 'base64url');
  return Buffer.concat([xBuffer, yBuffer]);
}

function serialiseEdDsaPublicKey(publicKey: KeyObject): Buffer {
  const algorithm = publicKey.asymmetricKeyType!;
  if (!['ed25519', 'ed448'].includes(algorithm)) {
    throw new Error(`Requested serialisation of EdDSA key but got ${algorithm} key`);
  }
  const keyJwt = publicKey.export({ format: 'jwk' });
  return Buffer.from(keyJwt.x!, 'base64url');
}

export function deserialisePublicKey(
  serialisation: Buffer,
  dnssecAlgorithm: DnssecAlgorithm,
): KeyObject {
  switch (dnssecAlgorithm) {
    case DnssecAlgorithm.RSASHA1:
    case DnssecAlgorithm.RSASHA256:
    case DnssecAlgorithm.RSASHA512: {
      return deserialiseRsaPublicKey(serialisation);
    }
    case DnssecAlgorithm.ECDSAP256SHA256:
    case DnssecAlgorithm.ECDSAP384SHA384: {
      return deserialiseEcDsaPublicKey(serialisation, dnssecAlgorithm);
    }
    case DnssecAlgorithm.ED25519:
    case DnssecAlgorithm.ED448: {
      return deserialiseEdDsaPublicKey(serialisation, dnssecAlgorithm);
    }
    default: {
      throw new Error(`Unsupported DNSSEC algorithm (${dnssecAlgorithm})`);
    }
  }
}

function deserialiseRsaPublicKey(serialisation: Buffer): KeyObject {
  const serialisationLength = serialisation.byteLength;
  if (serialisationLength < 3) {
    throw new Error(`Public key should contain at least 3 octets (got ${serialisationLength})`);
  }
  const isExponentSingleOctet = serialisation[0] !== 0;
  const exponentLength = isExponentSingleOctet
    ? serialisation.readUInt8(0)
    : serialisation.readUInt16BE(1);
  const exponentStartIndex = isExponentSingleOctet ? 1 : 3;
  const modulusStartIndex = exponentStartIndex + exponentLength;
  const exponentBuffer = serialisation.subarray(exponentStartIndex, modulusStartIndex);
  const modulusBuffer = serialisation.subarray(modulusStartIndex);
  return createPublicKey({
    key: {
      n: modulusBuffer.toString('base64url'),
      e: exponentBuffer.toString('base64url'),
      kty: 'RSA',
    },

    format: 'jwk',
  });
}

function deserialiseEcDsaPublicKey(
  serialisation: Buffer,
  algorithm: DnssecAlgorithm.ECDSAP256SHA256 | DnssecAlgorithm.ECDSAP384SHA384,
): KeyObject {
  const length = serialisation.byteLength;
  const expectedLength = ECDSA_CURVE_LENGTH[algorithm];
  if (length !== expectedLength) {
    throw new DnssecError(`ECDSA public key should span ${expectedLength} octets (got ${length})`);
  }

  const parametersLength = length / 2;
  const x = serialisation.subarray(0, parametersLength).toString('base64url');
  const y = serialisation.subarray(parametersLength).toString('base64url');
  const curveName = algorithm === DnssecAlgorithm.ECDSAP256SHA256 ? 'P-256' : 'P-384';
  return createPublicKey({
    key: { kty: 'EC', crv: curveName, x, y },
    format: 'jwk',
  });
}

function deserialiseEdDsaPublicKey(
  serialisation: Buffer,
  algorithm: DnssecAlgorithm.ED448 | DnssecAlgorithm.ED25519,
): KeyObject {
  const serialisationLength = serialisation.byteLength;
  if (algorithm === DnssecAlgorithm.ED25519 && serialisationLength !== 32) {
    throw new Error(`Ed25519 public key should span 32 octets (got ${serialisationLength})`);
  }
  if (algorithm === DnssecAlgorithm.ED448 && serialisationLength !== 57) {
    throw new Error(`Ed448 public key should span 57 octets (got ${serialisationLength})`);
  }

  const curveName = algorithm === DnssecAlgorithm.ED25519 ? 'Ed25519' : 'Ed448';
  const publicKeyBase64 = serialisation.toString('base64url');
  return createPublicKey({
    key: { crv: curveName, kty: 'OKP', x: publicKeyBase64 },
    format: 'jwk',
  });
}
