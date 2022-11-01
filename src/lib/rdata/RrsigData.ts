import { KeyObject, sign as cryptoSign } from 'node:crypto';
import { Parser } from 'binary-parser';
import { fromUnixTime, getUnixTime } from 'date-fns';

import { DnssecAlgorithm } from '../DnssecAlgorithm';
import { NAME_PARSER_OPTIONS, serialiseName } from '../dns/name';
import { InvalidRdataError } from '../errors';
import { DnssecRecordData } from './DnssecRecordData';
import { RRSet } from '../dns/RRSet';
import { getDNSSECAlgoFromKey, getNodejsHashAlgoFromKey } from '../signing/utils';
import { SecurityStatus } from '../verification/SecurityStatus';

const PARSER = new Parser()
  .endianness('big')
  .uint16('type')
  .uint8('algorithm')
  .uint8('labels')
  .uint32('ttl')
  .uint32('signatureExpiry')
  .uint32('signatureInception')
  .uint16('keyTag')
  .array('signerName', NAME_PARSER_OPTIONS)
  .buffer('signature', { readUntil: 'eof' });

export class RrsigData implements DnssecRecordData {
  static deserialise(serialisation: Buffer): RrsigData {
    let parsingResult: any;
    try {
      parsingResult = PARSER.parse(serialisation);
    } catch (_) {
      throw new InvalidRdataError('RRSIG data is malformed');
    }

    if (parsingResult.signature.byteLength === 0) {
      throw new InvalidRdataError('Signature is empty');
    }

    return new RrsigData(
      parsingResult.type,
      parsingResult.algorithm,
      parsingResult.labels,
      parsingResult.ttl,
      fromUnixTime(parsingResult.signatureExpiry),
      fromUnixTime(parsingResult.signatureInception),
      parsingResult.keyTag,
      parsingResult.signerName,
      parsingResult.signature,
    );
  }

  public static generate(
    rrset: RRSet,
    signatureExpiry: Date,
    signatureInception: Date,
    signerPrivateKey: KeyObject,
    signerName: string,
    signerKeyTag: number,
  ): RrsigData {
    const rdataFirstPart = generateRdataFirstPart(
      signatureExpiry,
      signatureInception,
      signerKeyTag,
      signerPrivateKey,
      rrset,
    );
    const plaintext = Buffer.concat([rdataFirstPart, serialiseRrset(rrset)]);
    const signature = sign(plaintext, signerPrivateKey);
    const algorithm = getDNSSECAlgoFromKey(signerPrivateKey);
    return new RrsigData(
      rrset.type,
      algorithm,
      countLabels(rrset.name),
      rrset.ttl,
      signatureExpiry,
      signatureInception,
      signerKeyTag,
      signerName,
      signature,
    );
  }

  constructor(
    public readonly type: number,
    public readonly algorithm: DnssecAlgorithm,
    public readonly labels: number,
    public readonly ttl: number,
    public readonly signatureExpiry: Date,
    public readonly signatureInception: Date,
    public readonly keyTag: number,
    public readonly signerName: string,
    public readonly signature: Buffer,
  ) {}

  public serialise(): Buffer {
    const signerNameBuffer = serialiseName(this.signerName);

    const serialisation = Buffer.allocUnsafe(
      18 + signerNameBuffer.byteLength + this.signature.byteLength,
    );

    serialisation.writeUInt16BE(this.type, 0);
    serialisation.writeUInt8(this.algorithm, 2);
    serialisation.writeUInt8(this.labels, 3);
    serialisation.writeUInt32BE(this.ttl, 4);
    serialisation.writeUInt32BE(getUnixTime(this.signatureExpiry), 8);
    serialisation.writeUInt32BE(getUnixTime(this.signatureInception), 12);
    serialisation.writeUInt16BE(this.keyTag, 16);
    signerNameBuffer.copy(serialisation, 18);
    this.signature.copy(serialisation, 18 + signerNameBuffer.byteLength);

    return serialisation;
  }

  public verifyRrset(rrset: RRSet): SecurityStatus {
    const parentZoneName = getParentZoneName(rrset.name);
    if (parentZoneName !== this.signerName) {
      return SecurityStatus.BOGUS;
    }

    if (rrset.type !== this.type) {
      return SecurityStatus.BOGUS;
    }

    if (rrset.ttl !== this.ttl) {
      return SecurityStatus.BOGUS;
    }

    if (this.labels < countLabels(rrset.name)) {
      return SecurityStatus.BOGUS;
    }

    return SecurityStatus.SECURE;
  }
}

// Calling this "first part" for lack of a better name, as RFC 4034 doesn't give it a name.
function generateRdataFirstPart(
  signatureExpiry: Date,
  signatureInception: Date,
  signerKeyTag: number,
  signerPrivateKey: KeyObject,
  rrset: RRSet,
): Buffer {
  const partialRrsigRdata = Buffer.allocUnsafe(18);

  partialRrsigRdata.writeUInt16BE(rrset.type, 0);
  partialRrsigRdata.writeUInt8(getDNSSECAlgoFromKey(signerPrivateKey), 2);
  partialRrsigRdata.writeUInt8(countLabels(rrset.name), 3);
  partialRrsigRdata.writeUInt32BE(rrset.ttl, 4);
  partialRrsigRdata.writeUInt32BE(getUnixTime(signatureExpiry), 8);
  partialRrsigRdata.writeUInt32BE(getUnixTime(signatureInception), 12);
  partialRrsigRdata.writeUInt16BE(signerKeyTag, 16);

  return partialRrsigRdata;
}

function serialiseRrset(rrset: RRSet): Buffer {
  return Buffer.concat(rrset.records.map((r) => r.serialise()));
}

function sign(plaintext: Buffer, privateKey: KeyObject): Buffer {
  const hashAlgorithm = getNodejsHashAlgoFromKey(privateKey);
  return cryptoSign(hashAlgorithm, plaintext, privateKey);
}

function countLabels(name: string): number {
  const nameWithoutTrailingDot = name.replace(/\.$/, '');
  const labels = nameWithoutTrailingDot.split('.').filter((label) => label !== '*');
  return labels.length;
}

function getParentZoneName(name: string): string {
  const parent = name.replace(/^[^.]+\./, '');
  return parent === '' ? '.' : parent;
}