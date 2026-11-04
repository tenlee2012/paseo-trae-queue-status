import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type {
  ProviderPermissionRequest,
  ProviderPermissionResponse,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";

const optionSchema = z.object({
  const: z.string(),
  title: z.string(),
  description: z.string().nullish(),
});
const fieldBase = z.object({ title: z.string().nullish(), description: z.string().nullish() });
const stringField = fieldBase.extend({
  type: z.literal("string"),
  enum: z.array(z.string()).nullish(),
  oneOf: z.array(optionSchema).nullish(),
});
const arrayField = fieldBase.extend({
  type: z.literal("array"),
  items: z.object({
    type: z.literal("string").optional(),
    enum: z.array(z.string()).optional(),
    anyOf: z.array(optionSchema).optional(),
  }),
});
const formSchema = z.object({
  mode: z.literal("form"),
  sessionId: z.string(),
  message: z.string(),
  toolCallId: z.string().nullish(),
  requestedSchema: z.object({
    type: z.literal("object"),
    properties: z
      .record(z.string(), z.union([stringField, arrayField]))
      .refine((fields) => Object.keys(fields).length > 0),
    required: z.array(z.string()).nullish(),
  }),
});
const nativeQuestionSchema = z.object({
  header: z.string(),
  question: z.string(),
  isOther: z.boolean().optional(),
  multiSelect: z.boolean().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).nullish(),
});
const nativeUpdateSchema = z.object({
  sessionId: z.string(),
  update: z.object({
    sessionUpdate: z.enum(["tool_call", "tool_call_update"]),
    toolCallId: z.string(),
    status: z.string().optional(),
    rawInput: z.object({ questions: z.array(nativeQuestionSchema) }).optional(),
  }),
});
const answersSchema = z.record(z.string(), z.string());
type Field = z.infer<typeof stringField> | z.infer<typeof arrayField>;
interface Choice {
  label: string;
  value: string;
  description?: string;
}
interface QuestionField {
  key: string;
  header: string;
  question: string;
  customKey: string | null;
  multiSelect: boolean;
  allowOther: boolean;
  required: boolean;
  choices: Choice[];
}
interface PendingQuestion {
  id: string | number;
  sessionId: string;
  fields: QuestionField[];
  submitting: boolean;
}

export interface TraeQuestionEvents {
  question(sessionId: string, request: ProviderPermissionRequest): void;
  resolved(sessionId: string, permissionId: string): void;
}

// The ACP shim has no elicitation handler. Keep TRAE's form transport here and
// publish the same permission kind and question shape used by Codex's UI.
export class TraeQuestions {
  private readonly nativeQuestions = new Map<string, z.infer<typeof nativeQuestionSchema>[]>();
  private readonly pending = new Map<string, PendingQuestion>();
  constructor(
    private readonly write: (message: AcpStreamMessage) => Promise<void>,
    private readonly events: TraeQuestionEvents,
  ) {}

  incoming(message: AcpStreamMessage): boolean | AcpStreamMessage {
    if (!("method" in message)) return false;
    if (message.method === "session/update") {
      const parsedUpdate = nativeUpdateSchema.safeParse(message.params);
      if (!parsedUpdate.success) return false;
      const { sessionId, update } = parsedUpdate.data;
      const key = JSON.stringify([sessionId, update.toolCallId]);
      if (update.status === "completed" || update.status === "failed")
        this.nativeQuestions.delete(key);
      else if (update.rawInput) this.nativeQuestions.set(key, update.rawInput.questions);
      return false;
    }
    if (message.method === "$/cancel_request") {
      const params = z
        .object({ requestId: z.union([z.string(), z.number()]) })
        .safeParse(message.params);
      if (params.success) this.remove(permissionId(params.data.requestId));
      return false;
    }
    if (message.method !== "elicitation/create" || !("id" in message) || message.id === null)
      return false;
    const parsed = formSchema.safeParse(message.params);
    if (!parsed.success) {
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32602,
          message: "Paseo supports session form questions with string or string-choice fields",
        },
      };
    }
    const form = parsed.data;
    const native = this.nativeQuestions.get(JSON.stringify([form.sessionId, form.toolCallId]));
    const fields = questionFields(form, native);
    const id = permissionId(message.id);
    this.pending.set(id, {
      id: message.id,
      sessionId: form.sessionId,
      fields,
      submitting: false,
    });
    this.events.question(form.sessionId, {
      id,
      name: "request_user_input",
      kind: "question",
      title: "Question",
      description: form.message,
      input: {
        questions: fields.map((field) => ({
          header: field.header,
          question: field.question,
          options: field.choices.map((option) => ({
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
          })),
          multiSelect: field.multiSelect,
          allowOther: field.allowOther,
          allowEmpty: !field.required,
        })),
      },
    });
    return true;
  }

  has(id: string): boolean {
    return this.pending.has(id);
  }

  async respond(id: string, response: ProviderPermissionResponse): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending) throw new Error(`Unknown TRAE question: ${id}`);
    if (pending.submitting) throw new Error("TRAE question is already being submitted");
    let result: unknown = { action: "cancel" };
    if (response.behavior === "allow") {
      const answers = answersSchema.parse(response.updatedInput?.answers);
      const content: Record<string, string | string[]> = {};
      for (const entry of pending.fields) {
        const answer = answers[entry.header] ?? "";
        if (!answer && !entry.required) continue;
        if (!answer) throw new Error(`Answer required: ${entry.key}`);
        Object.assign(content, answerContent(entry, answer));
      }
      result = { action: "accept", content };
    }
    pending.submitting = true;
    try {
      await this.write({ jsonrpc: "2.0", id: pending.id, result });
      this.remove(id);
    } finally {
      pending.submitting = false;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const responses = [...this.pending]
      .filter(([, question]) => question.sessionId === sessionId)
      .map(([id]) => this.respond(id, { behavior: "deny" }));
    await Promise.all(responses);
  }

  close(): void {
    for (const id of this.pending.keys()) this.remove(id);
    this.nativeQuestions.clear();
  }

  private remove(id: string): void {
    const question = this.pending.get(id);
    if (!question) return;
    this.pending.delete(id);
    this.events.resolved(question.sessionId, id);
  }
}

function permissionId(id: string | number): string {
  return `trae-question:${typeof id}:${id}`;
}
function choices(field: Field): Choice[] {
  if (field.type === "string" && field.oneOf)
    return field.oneOf.map((option) => ({
      label: option.title,
      value: option.const,
      description: option.description ?? undefined,
    }));
  if (field.type === "array" && field.items.anyOf)
    return field.items.anyOf.map((option) => ({
      label: option.title,
      value: option.const,
      description: option.description ?? undefined,
    }));
  const values = field.type === "string" ? field.enum : field.items.enum;
  return (values ?? []).map((value) => ({ label: value, value }));
}
function questionFields(
  form: z.infer<typeof formSchema>,
  native: z.infer<typeof nativeQuestionSchema>[] | undefined,
): QuestionField[] {
  const fields: QuestionField[] = [];
  const properties = form.requestedSchema.properties;
  const customKeys = new Set<string>();
  const headers = new Set<string>();
  for (const [key, field] of Object.entries(properties)) {
    if (customKeys.has(key)) continue;
    const index = /^question_(\d+)$/.exec(key);
    const original = index ? native?.[Number(index[1])] : undefined;
    const options = choices(field);
    const candidateCustomKey = `${key}_custom`;
    const hasCustomField = options.length > 0 && properties[candidateCustomKey]?.type === "string";
    const customKey = hasCustomField ? candidateCustomKey : null;
    if (customKey) customKeys.add(customKey);
    const title = original?.header ?? field.title ?? key;
    const header = headers.has(title) ? `${title} (${key})` : title;
    headers.add(header);
    const question = original?.question ?? field.description ?? form.message;
    fields.push({
      key,
      header,
      question,
      customKey,
      multiSelect: field.type === "array",
      allowOther: customKey !== null || options.length === 0,
      required: original !== undefined || form.requestedSchema.required?.includes(key) === true,
      choices: options.map((option) => ({
        label: option.label,
        value: option.value,
        description:
          original?.options?.find((candidate) => candidate.label === option.label)?.description ??
          option.description,
      })),
    });
  }
  return fields;
}

function answerContent(entry: QuestionField, answer: string): Record<string, string | string[]> {
  if (entry.choices.length === 0) return { [entry.key]: answer };
  if (!entry.multiSelect) {
    const choice = entry.choices.find((option) => option.label === answer);
    if (choice) return { [entry.key]: choice.value };
    if (entry.customKey) return { [entry.customKey]: answer };
    throw new Error(`Invalid choice for ${entry.header}`);
  }
  const selected: string[] = [];
  let rest = answer;
  const remaining = entry.choices.toSorted((a, b) => b.label.length - a.label.length);
  while (rest) {
    const index = remaining.findIndex(
      (option) => rest === option.label || rest.startsWith(`${option.label}, `),
    );
    if (index === -1) break;
    const [choice] = remaining.splice(index, 1);
    selected.push(choice.value);
    rest = rest.slice(choice.label.length + 2);
  }
  if (rest && !entry.customKey) throw new Error(`Invalid choice for ${entry.header}`);
  const content: Record<string, string | string[]> = {};
  if (selected.length > 0) content[entry.key] = selected;
  if (rest && entry.customKey) content[entry.customKey] = rest;
  return content;
}
