import { Curve, hmacSign } from './crypto.js';
import {
  decodeADVSignedDeviceIdentityHMAC,
  decodeADVSignedDeviceIdentity,
  decodeADVDeviceIdentity,
  encodeADVSignedDeviceIdentity
} from './proto.js';

const WA_ADV_ACCOUNT_SIG_PREFIX = Buffer.from([6, 0]);
const WA_ADV_DEVICE_SIG_PREFIX = Buffer.from([6, 1]);
const WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX = Buffer.from([6, 5]);
const WA_ADV_HOSTED_DEVICE_SIG_PREFIX = Buffer.from([6, 6]);

// E2EE = 0, HOSTED = 1
export const ADVEncryptionType = { E2EE: 0, HOSTED: 1 };

const getBinaryNodeChild = (node, tag) => {
  if (!node.content || !Array.isArray(node.content)) return null;
  return node.content.find((c) => c && c.tag === tag) || null;
};

/**
 * Processa o par sucesso: valida as assinaturas, gera a assinatura de dispositivo
 * e retorna { reply, creds } para reenviar.
 */
export async function configureSuccessfulPairing(stanza, { advSecretKey, signedIdentityKey }) {
  const msgId = stanza.attrs.id;
  const pairSuccessNode = getBinaryNodeChild(stanza, 'pair-success');
  const deviceIdentityNode = getBinaryNodeChild(pairSuccessNode, 'device-identity');
  const platformNode = getBinaryNodeChild(pairSuccessNode, 'platform');
  const deviceNode = getBinaryNodeChild(pairSuccessNode, 'device');
  const businessNode = getBinaryNodeChild(pairSuccessNode, 'biz');

  if (!deviceIdentityNode || !deviceNode) {
    throw new Error('Missing device-identity or device in pair success node');
  }
  const bizName = businessNode?.attrs?.name;
  const jid = deviceNode.attrs.jid;
  const lid = deviceNode.attrs.lid;

  const { details, hmac, accountType } = decodeADVSignedDeviceIdentityHMAC(deviceIdentityNode.content);

  let hmacPrefix = Buffer.alloc(0);
  if (accountType !== undefined && accountType === ADVEncryptionType.HOSTED) {
    hmacPrefix = WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX;
  }

  const advSign = hmacSign(Buffer.concat([hmacPrefix, details]), Buffer.from(advSecretKey, 'base64'));
  if (Buffer.compare(hmac, advSign) !== 0) {
    throw new Error('Invalid account signature');
  }

  const account = decodeADVSignedDeviceIdentity(details);
  const { accountSignatureKey, accountSignature, details: deviceDetails } = account;
  const deviceIdentity = decodeADVDeviceIdentity(deviceDetails);

  const accountSignaturePrefix =
    deviceIdentity.deviceType === ADVEncryptionType.HOSTED
      ? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
      : WA_ADV_ACCOUNT_SIG_PREFIX;

  const accountMsg = Buffer.concat([accountSignaturePrefix, deviceDetails, signedIdentityKey.public]);
  const verified = await Curve.verify(accountSignatureKey, accountMsg, accountSignature);
  if (!verified) {
    throw new Error('Failed to verify account signature');
  }

  const deviceMsg = Buffer.concat([
    WA_ADV_DEVICE_SIG_PREFIX,
    deviceDetails,
    signedIdentityKey.public,
    accountSignatureKey
  ]);
  account.deviceSignature = await Curve.sign(signedIdentityKey.private, deviceMsg);

  // no pair-device-sign, o accountSignatureKey NÃO deve ser enviado
  const accountEnc = encodeADVSignedDeviceIdentity({
    details: account.details,
    accountSignature: account.accountSignature,
    deviceSignature: account.deviceSignature
  });

  const reply = {
    tag: 'iq',
    attrs: { to: 's.whatsapp.net', type: 'result', id: msgId },
    content: [
      {
        tag: 'pair-device-sign',
        attrs: {},
        content: [
          {
            tag: 'device-identity',
            attrs: { 'key-index': deviceIdentity.keyIndex.toString() },
            content: accountEnc
          }
        ]
      }
    ]
  };

  const authUpdate = {
    account,
    me: { id: jid, name: bizName, lid },
    platform: platformNode?.attrs?.name
  };

  return { creds: authUpdate, reply };
}
