/**
 * lib/hedera/HederaService.ts
 * Hedera integration: HCS (consensus timestamps) + HTS (NFT receipts).
 * Two prize tracks: "No Solidity Allowed" ($3k) + "AI & Agentic Payments" ($6k).
 * SERVER-SIDE ONLY. Never import in "use client" components.
 */

export interface HCSResult {
  topicId:            string;
  sequenceNumber:     number;
  consensusTimestamp: string | null;
  transactionId:      string;
  mirrorNodeUrl:      string;
}

export interface HTSMintResult {
  tokenId:       string;
  serialNumber:  number;
  transactionId: string;
  mirrorNodeUrl: string;
}

export interface HederaServiceResult {
  hcs:           HCSResult | null;
  hts:           HTSMintResult | null;
  bothSucceeded: boolean;
}

async function buildClient() {
  const { Client, PrivateKey } = await import('@hashgraph/sdk');
  const id  = process.env.HEDERA_OPERATOR_ID;
  const key = process.env.HEDERA_OPERATOR_KEY;
  if (!id || !key) { console.warn('[Hedera] Credentials missing'); return null; }
  const client = process.env.HEDERA_NETWORK === 'mainnet'
    ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(id, PrivateKey.fromStringDer(key));
  return client;
}

export async function submitToHCS(payload: {
  deliveryId: string; documentHash: string; caseRef: string; servedTo: string; servedBy: string;
}): Promise<HCSResult | null> {
  const topicId = process.env.HEDERA_HCS_TOPIC_ID;
  if (!topicId) { console.warn('[Hedera] HEDERA_HCS_TOPIC_ID not set'); return null; }
  const { TopicMessageSubmitTransaction, TopicId } = await import('@hashgraph/sdk');
  const client = await buildClient();
  if (!client) return null;
  const message = JSON.stringify({ eps: 'v1', ...payload, submittedAt: new Date().toISOString() });
  try {
    const response = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId)).setMessage(message).execute(client);
    const receipt = await response.getReceipt(client);
    client.close();
    const seqNum = receipt.topicSequenceNumber?.toNumber() ?? 0;
    const network = process.env.HEDERA_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
    let consensusTimestamp: string | null = null;
    try {
      const ts = (receipt as unknown as Record<string, unknown>).consensusTimestamp;
      if (ts != null) {
        const toDate = (ts as Record<string, unknown>).toDate;
        if (typeof toDate === 'function') consensusTimestamp = (toDate as () => Date).call(ts).toISOString();
      }
    } catch { /* not available on all receipt types */ }
    return { topicId, sequenceNumber: seqNum, consensusTimestamp, transactionId: response.transactionId.toString(),
      mirrorNodeUrl: `https://${network}.mirrornode.hedera.com/api/v1/topics/${topicId}/messages/${seqNum}` };
  } catch (err) { client.close(); console.error('[Hedera] HCS error:', err); return null; }
}

export async function mintProofNFT(payload: {
  deliveryId: string; documentHash: string; caseRef: string;
}): Promise<HTSMintResult | null> {
  const tokenId = process.env.HEDERA_NFT_TOKEN_ID;
  if (!tokenId) { console.warn('[Hedera] HEDERA_NFT_TOKEN_ID not set'); return null; }
  const { TokenMintTransaction, TokenId } = await import('@hashgraph/sdk');
  const client = await buildClient();
  if (!client) return null;
  // Hedera HTS caps NFT metadata at 100 bytes — a full JSON blob overflows it
  // and the mint receipt comes back METADATA_TOO_LONG. Per the HTS / wallet
  // convention the on-chain metadata is a URI pointing to a JSON document;
  // HashScan fetches it to render the certificate image + attributes.
  // The URL is ~62 bytes, comfortably under the cap, and a hard truncation
  // guard keeps us safe even if topic/seq grow (issue #158).
  const hcsTopic = process.env.HEDERA_HCS_TOPIC_ID ?? '0.0.9225885';
  const metaUri = `https://eps-dapp.vercel.app/api/nft/meta?topic=${hcsTopic}&caseRef=${encodeURIComponent(payload.caseRef)}`;
  let metadata = Buffer.from(metaUri, 'utf8');
  if (metadata.length > 100) {
    metadata = metadata.subarray(0, 100);
  }
  try {
    const response = await new TokenMintTransaction()
      .setTokenId(TokenId.fromString(tokenId)).addMetadata(metadata).execute(client);
    const receipt = await response.getReceipt(client);
    client.close();
    const serialNumber = receipt.serials?.[0]?.toNumber() ?? 0;
    const network = process.env.HEDERA_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
    return { tokenId, serialNumber, transactionId: response.transactionId.toString(),
      mirrorNodeUrl: `https://${network}.mirrornode.hedera.com/api/v1/tokens/${tokenId}/nfts/${serialNumber}` };
  } catch (err) { client.close(); console.error('[Hedera] HTS mint error:', err); return null; }
}

export async function recordOnHedera(payload: {
  deliveryId: string; documentHash: string; caseRef: string; servedTo: string; servedBy: string;
}): Promise<HederaServiceResult> {
  const [hcsR, htsR] = await Promise.allSettled([submitToHCS(payload), mintProofNFT(payload)]);
  if (hcsR.status === 'rejected') console.error('[Hedera] HCS failed:', hcsR.reason);
  if (htsR.status === 'rejected') console.error('[Hedera] HTS failed:', htsR.reason);
  const hcs = hcsR.status === 'fulfilled' ? hcsR.value : null;
  const hts = htsR.status === 'fulfilled' ? htsR.value : null;
  return { hcs, hts, bothSucceeded: !!hcs && !!hts };
}
