import { Parser } from 'binary-parser';
import { KeyObject } from 'node:crypto';

import { DnssecAlgorithm } from '../DnssecAlgorithm';
import { DnskeyFlags } from '../DnskeyFlags';
import { InvalidRdataError } from '../errors';
import { DnssecRecordData } from './DnssecRecordData';
import { RrsigData } from './RrsigData';
import { deserialisePublicKey, serialisePublicKey } from '../utils/keySerialisation';

const PARSER = new Parser()
  .endianness('big')
  .bit8('zoneKey')
  .bit8('secureEntryPoint')
  .uint8('protocol')
  .uint8('algorithm')
  .buffer('publicKey', { readUntil: 'eof' });

export class DnskeyData implements DnssecRecordData {
  public static deserialise(serialisation: Buffer): DnskeyData {
    let parsingResult: any;
    try {
      parsingResult = PARSER.parse(serialisation);
    } catch (_) {
      throw new InvalidRdataError('DNSKEY data is malformed');
    }
    const publicKey = deserialisePublicKey(parsingResult.publicKey, parsingResult.algorithm);
    const flags: DnskeyFlags = {
      zoneKey: !!parsingResult.zoneKey,
      secureEntryPoint: !!parsingResult.secureEntryPoint,
    };
    const keyTag = calculateKeyTag(serialisation);
    return new DnskeyData(
      publicKey,
      parsingResult.protocol,
      parsingResult.algorithm,
      flags,
      keyTag,
    );
  }

  constructor(
    public readonly publicKey: KeyObject,
    public readonly protocol: number,
    public readonly algorithm: DnssecAlgorithm,
    public readonly flags: DnskeyFlags,
    public readonly keyTag: number | null = null,
  ) {}

  public serialise(): Buffer {
    const publicKeyEncoded = serialisePublicKey(this.publicKey);
    const data = Buffer.alloc(4 + publicKeyEncoded.byteLength);

    if (this.flags.zoneKey) {
      data.writeUInt8(0b00000001, 0);
    }
    if (this.flags.secureEntryPoint) {
      data.writeUInt8(0b00000001, 1);
    }

    data.writeUInt8(this.protocol, 2);

    data.writeUInt8(this.algorithm, 3);

    publicKeyEncoded.copy(data, 4);
    return data;
  }

  public calculateKeyTag(): number {
    if (this.keyTag !== null) {
      return this.keyTag;
    }
    // We should probably cache the calculation, but that'd only help in situations where we're
    // *generating* DNSKEYs (e.g., in test suites).
    const rdata = this.serialise();
    return calculateKeyTag(rdata);
  }

  public verifyRrsig(rrsigData: RrsigData, referenceDate: Date): boolean {
    if (this.calculateKeyTag() !== rrsigData.keyTag) {
      return false;
    }

    if (this.algorithm !== rrsigData.algorithm) {
      return false;
    }

    if (rrsigData.signatureExpiry < referenceDate) {
      return false;
    }

    return referenceDate >= rrsigData.signatureInception;
  }
}

/**
 * Return key tag for DNSKEY.
 *
 * RFC 4034 (Appendix B) requires using one of two algorithms depending on the DNSSEC crypto
 * algorithm used, but since one of them is for Algorithm 1 (RSA/MD5) -- which we won't
 * support -- we're only supporting one key tag algorithm.
 */
function calculateKeyTag(rdata: Buffer) {
  // Algorithm pretty much copy/pasted from https://www.rfc-editor.org/rfc/rfc4034#appendix-B
  let accumulator = 0;
  for (let index = 0; index < rdata.byteLength; ++index) {
    accumulator += index & 1 ? rdata[index] : rdata[index] << 8;
  }
  accumulator += (accumulator >> 16) & 0xffff;
  return accumulator & 0xffff;
}