/**
 * FeishuTransport — 飞书 SDK 的完整端口
 *
 * 封装 @larksuiteoapi/node-sdk 的所有调用。FeishuBridge 通过此端口
 * 与飞书通信，不直接依赖 SDK 类型。测试可注入 fake transport。
 *
 * Q1 决策：auth.tenantToken 归端口（被 CardStream/open 复用），
 * testConnection 留在 Bridge（仅配置页探测，不属于运行时传输）。
 * Q2 决策：CardStream 实现 Transport 接口。
 * Q3 决策：端口暴露 startWs(handlers) + subscribe。
 * Q4 决策：一个 downloadMessageResource，内部自行回退到 image-key 路径。
 * Q5 决策：params 构造在 Bridge（业务规则），端口只负责发送。
 */

import type { LarkClient, LarkSDK, FeishuGroupMember } from "./types";

export interface FeishuTransport {
  // --- messaging (CardStream + Bridge) ---
  createInteractiveMessage(chatId: string, card: object): Promise<string>;
  replyInteractiveMessage(replyToMessageId: string, card: object): Promise<string>;
  patchMessage(messageId: string, card: object): Promise<void>;
  sendTextMessage(chatId: string, text: string, opts?: { replyToMessageId?: string }): Promise<void>;
  sendPostMessage(chatId: string, post: object, opts?: { replyToMessageId?: string }): Promise<void>;
  sendFileMessage(chatId: string, fileKey: string, fileName: string): Promise<void>;

  // --- files ---
  uploadFile(fileName: string, data: Buffer): Promise<string>;
  downloadMessageResource(messageId: string, fileKey: string, type: "image" | "file"): Promise<Buffer>;
  downloadImageByKey(imageKey: string): Promise<Buffer>;

  // --- chat (session mirror) ---
  createChat(name: string, opts?: { userOpenId?: string }): Promise<string>;
  getChat(chatId: string): Promise<Record<string, unknown>>;
  addChatMember(chatId: string, userOpenId: string): Promise<void>;
  getChatMembers(chatId: string): Promise<FeishuGroupMember[]>;

  // --- docs ---
  createDoc(title: string): Promise<{ documentId: string; url: string }>;
  appendDocBlocks(documentId: string, children: unknown[]): Promise<void>;

  // --- auth ---
  getBotInfo(): Promise<{ openId: string; appName: string } | null>;

  // --- WS lifecycle (Q3) ---
  startWs(handlers?: Record<string, (data: unknown) => Promise<void>>): Promise<void>;
  subscribe(event: string, handler: (data: unknown) => Promise<void>): () => void;
  stopWs(): void;

  // --- escape hatch ---
  rawRequest(opts: { method: string; url: string; data?: Record<string, unknown>; params?: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

let larkSDK: LarkSDK | null = null;
async function getLark(): Promise<LarkSDK> {
  if (larkSDK) return larkSDK;
  const mod = await import("@larksuiteoapi/node-sdk") as unknown as LarkSDK;
  larkSDK = mod;
  return mod;
}

export class FeishuTransportImpl implements FeishuTransport {
  private client: LarkClient | null = null;
  private wsClient: unknown = null;
  private dispatcher: unknown = null;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  private async getClient(): Promise<LarkClient> {
    if (this.client) return this.client;
    const lark = await getLark();
    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.error,
    } as Record<string, unknown>) as LarkClient;
    return this.client;
  }

  async createInteractiveMessage(chatId: string, card: object): Promise<string> {
    const client = await this.getClient();
    const sent = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) },
    });
    const messageId = (sent as { data?: { message_id?: string } })?.data?.message_id;
    if (!messageId) throw new Error("发送卡片消息未返回 message_id");
    return messageId;
  }

  async replyInteractiveMessage(replyToMessageId: string, card: object): Promise<string> {
    const client = await this.getClient();
    const sent = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: { msg_type: "interactive", content: JSON.stringify(card) },
    });
    return (sent as { data?: { message_id?: string } })?.data?.message_id ?? "";
  }

  async patchMessage(messageId: string, card: object): Promise<void> {
    const client = await this.getClient();
    await client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  }

  async sendTextMessage(chatId: string, text: string, opts?: { replyToMessageId?: string }): Promise<void> {
    const client = await this.getClient();
    const payload: Record<string, unknown> = {
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    };
    if (opts?.replyToMessageId) (payload as Record<string, unknown>).path = { message_id: opts.replyToMessageId };
    await client.im.message.create(payload);
  }

  async sendPostMessage(chatId: string, post: object, opts?: { replyToMessageId?: string }): Promise<void> {
    const client = await this.getClient();
    (async () => {
      const payload: Record<string, unknown> = {
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "post", content: JSON.stringify(post) },
      };
      if (opts?.replyToMessageId) (payload as Record<string, unknown>).path = { message_id: opts.replyToMessageId };
      await client.im.message.create(payload);
    })();
  }

  async sendFileMessage(chatId: string, fileKey: string, fileName: string): Promise<void> {
    const client = await this.getClient();
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "file", content: JSON.stringify({ file_key: fileKey }) },
    });
  }

  async uploadFile(fileName: string, data: Buffer): Promise<string> {
    const client = await this.getClient();
    const resp = await client.im.file!.create({
      data: { file_type: "stream", file_name: fileName, file: data },
    });
    const fileKey = (resp as Record<string, unknown>)?.file_key as string;
    if (!fileKey) throw new Error("上传文件失败");
    return fileKey;
  }

  async downloadMessageResource(messageId: string, fileKey: string, type: "image" | "file"): Promise<Buffer> {
    const client = await this.getClient();
    const resp = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });
    return this.streamToBuffer(resp);
  }

  async downloadImageByKey(imageKey: string): Promise<Buffer> {
    const client = await this.getClient();
    const resp = await client.request({
      method: "GET",
      url: `https://open.feishu.cn/open-apis/im/v1/images/${imageKey}`,
    });
    return this.streamToBuffer(resp);
  }

  async createChat(name: string, opts?: { userOpenId?: string }): Promise<string> {
    const client = await this.getClient();
    const chatData: Record<string, unknown> = {
      name, chat_mode: "group", chat_type: "private", external: false,
    };
    if (opts?.userOpenId) chatData.user_id_list = [opts.userOpenId];
    const resp = await client.im.chat.create({
      data: chatData,
      params: { user_id_type: "open_id" },
    });
    const data = (resp as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
    const chatId = data?.chat_id as string | undefined ?? (resp as Record<string, unknown>)?.chat_id as string | undefined;
    if (!chatId) throw new Error("创建群聊未返回 chat_id");
    return chatId;
  }

  async getChat(chatId: string): Promise<Record<string, unknown>> {
    const client = await this.getClient();
    const resp = await client.im.chat.get({ path: { chat_id: chatId } });
    return resp as Record<string, unknown>;
  }

  async addChatMember(chatId: string, userOpenId: string): Promise<void> {
    const client = await this.getClient();
    await client.im.chat.members.add({
      path: { chat_id: chatId },
      data: { id_list: [userOpenId] },
      params: { member_id_type: "open_id" },
    });
  }

  async getChatMembers(chatId: string): Promise<FeishuGroupMember[]> {
    const client = await this.getClient();
    const resp = await client.im.chat.members.get({
      path: { chat_id: chatId },
      params: { user_id_type: "open_id", page_size: 100 },
    });
    return (((resp as Record<string, unknown>)?.data as Record<string, unknown>)?.items ?? []) as FeishuGroupMember[];
  }

  async createDoc(title: string): Promise<{ documentId: string; url: string }> {
    const client = await this.getClient();
    const resp = await client.request({
      method: "POST",
      url: "https://open.feishu.cn/open-apis/docx/v1/documents",
      data: { title },
    });
    const doc = (resp as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
    const documentId = doc?.document_id as string | undefined;
    if (!documentId) throw new Error("创建文档失败");
    return { documentId, url: (doc?.url as string) ?? `https://www.feishu.cn/docx/${documentId}` };
  }

  async appendDocBlocks(documentId: string, children: unknown[]): Promise<void> {
    const client = await this.getClient();
    await client.request({
      method: "POST",
      url: `https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
      params: { document_revision_id: -1 },
      data: { children, index: 0 },
    });
  }

  async getBotInfo(): Promise<{ openId: string; appName: string } | null> {
    const client = await this.getClient();
    const resp = await client.request<{
      code?: number; bot?: { open_id?: string; app_name?: string };
      data?: { bot?: { open_id?: string; app_name?: string } };
    }>({ method: "GET", url: "https://open.feishu.cn/open-apis/bot/v3/info/" });
    const bot = resp?.bot ?? resp?.data?.bot;
    if (!bot?.open_id) return null;
    return { openId: bot.open_id, appName: bot.app_name ?? "" };
  }

  // Q3: WS lifecycle — handlers registered BEFORE ws.start() to preserve event ordering.
  async startWs(handlers?: Record<string, (data: unknown) => Promise<void>>): Promise<void> {
    const lark = await getLark();
    this.dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error });
    if (handlers) {
      for (const [event, handler] of Object.entries(handlers)) {
        (this.dispatcher as { register: (map: Record<string, unknown>) => void }).register({ [event]: handler });
      }
    }
    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.error,
    });
    (this.wsClient as { start: (opts: { eventDispatcher: unknown }) => void }).start({ eventDispatcher: this.dispatcher });
  }

  subscribe(event: string, handler: (data: unknown) => Promise<void>): () => void {
    if (!this.dispatcher) throw new Error("WS not started");
    (this.dispatcher as { register: (map: Record<string, unknown>) => void }).register({ [event]: handler });
    return () => {};
  }

  stopWs(): void {
    if (this.wsClient) {
      try { (this.wsClient as { stop?: () => void }).stop?.(); } catch {}
    }
    this.client = null;
    this.wsClient = null;
    this.dispatcher = null;
  }

  async rawRequest(opts: { method: string; url: string; data?: Record<string, unknown>; params?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const client = await this.getClient();
    return client.request(opts);
  }

  private async streamToBuffer(result: unknown): Promise<Buffer> {
    const resp = result as Record<string, unknown>;
    if (typeof resp?.getReadableStream === "function") {
      const chunks: Buffer[] = [];
      const readable = (resp.getReadableStream as () => NodeJS.ReadableStream)();
      for await (const chunk of readable as AsyncIterable<Buffer | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    if (typeof (result as AsyncIterable<unknown>)?.[Symbol.asyncIterator] === "function") {
      const chunks: Buffer[] = [];
      for await (const chunk of result as AsyncIterable<Buffer | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    if (typeof resp?.writeFile === "function") {
      const { readFileSync, unlinkSync } = await import("node:fs");
      const tmp = `/tmp/feishu-dl-${Date.now()}.tmp`;
      await (resp.writeFile as (p: string) => Promise<void>)(tmp);
      const data = readFileSync(tmp);
      try { unlinkSync(tmp); } catch {}
      return data;
    }
    throw new Error("无法读取飞书文件流");
  }
}
