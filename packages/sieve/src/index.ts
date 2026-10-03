import { parsers } from "prettier-plugin-sieve";

export interface SieveContext {
  envelopeFrom: string;
  envelopeTo: string;
  headers: Record<string, string>;
  size: number;
}

export interface VacationPlan {
  kind: "vacation";
  days: number;
  handle: string;
  subject: string | null;
  reason: string;
}

export interface CompiledSieve {
  profile: "agentpostoffice-autoresponder-v1";
  ast: Node;
}

interface Node {
  type: string;
  [key: string]: unknown;
}

export class SieveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SieveValidationError";
  }
}

const PROFILE = "agentpostoffice-autoresponder-v1" as const;
const ALLOWED_CAPABILITIES = new Set(["envelope", "vacation"]);
const ALLOWED_NODES = new Set([
  "Script", "Require", "If", "ElseIf", "Else", "Block",
  "AllofTest", "AnyofTest", "NotTest", "AddressTest", "HeaderTest", "EnvelopeTest",
  "SizeTest", "ExistsTest", "TrueTest", "FalseTest", "GenericTest", "Vacation", "Stop", "TaggedArg",
]);

export function compileSieve(source: string): CompiledSieve {
  if (new TextEncoder().encode(source).byteLength > 65_536) {
    throw new SieveValidationError("Sieve source must not exceed 64 KiB");
  }
  let ast: Node;
  try {
    const parse = parsers.sieve?.parse as unknown as (text: string, options: Record<string, unknown>) => unknown;
    if (!parse) throw new Error("Sieve parser is unavailable");
    ast = parse(source, { filepath: "script.sieve" }) as Node;
  } catch (error) {
    throw new SieveValidationError(`Invalid Sieve syntax: ${error instanceof Error ? error.message : "parse failed"}`);
  }
  validateNode(ast, 0);
  return { profile: PROFILE, ast };
}

export function evaluateSieve(compiled: CompiledSieve, context: SieveContext): VacationPlan | null {
  if (compiled.profile !== PROFILE) throw new SieveValidationError("Unsupported compiled Sieve profile");
  const result = executeCommands(asNodes(compiled.ast.commands), normalizedContext(context));
  return result.plan;
}

function validateNode(node: Node, depth: number): void {
  if (depth > 32) throw new SieveValidationError("Sieve nesting must not exceed 32 levels");
  if (!ALLOWED_NODES.has(node.type)) throw new SieveValidationError(`Unsupported Sieve construct: ${node.type}`);
  if (node.type === "Require") {
    for (const capability of asStrings(node.capabilities)) {
      if (!ALLOWED_CAPABILITIES.has(capability.toLowerCase())) {
        throw new SieveValidationError(`Unsupported Sieve capability: ${capability}`);
      }
    }
  }
  if (node.type === "GenericTest" && !["address", "header", "envelope"].includes(String(node.name).toLowerCase())) {
    throw new SieveValidationError(`Unsupported Sieve test: ${String(node.name)}`);
  }
  if (node.type === "GenericTest") {
    const args = asNodes(node.args);
    if (args.length !== 1 || !["is", "contains", "matches"].includes(String(args[0]?.name).toLowerCase())) {
      throw new SieveValidationError(`Unsupported Sieve match tag: :${String(args[0]?.name || "missing")}`);
    }
    if (String(node.name).toLowerCase() === "envelope" && !["from", "to"].includes(String(args[0]?.value).toLowerCase())) {
      throw new SieveValidationError(`Unsupported envelope part: ${String(args[0]?.value)}`);
    }
  }
  if (["AddressTest", "HeaderTest", "EnvelopeTest"].includes(node.type)) validateMatchArgs(asNodes(node.args));
  if (node.type === "Vacation") validateVacation(node);
  for (const value of Object.values(node)) {
    if (isNode(value)) validateNode(value, depth + 1);
    else if (Array.isArray(value)) for (const item of value) if (isNode(item)) validateNode(item, depth + 1);
  }
}

function validateMatchArgs(args: Node[]): void {
  const allowed = new Set(["is", "contains", "matches", "all", "localpart", "domain", "comparator"]);
  for (const argument of args) {
    const name = String(argument.name || "").toLowerCase();
    if (!allowed.has(name)) throw new SieveValidationError(`Unsupported Sieve match tag: :${name}`);
    if (name === "comparator" && String(argument.value).toLowerCase() !== "i;ascii-casemap" && String(argument.value).toLowerCase() !== "i;octet") {
      throw new SieveValidationError(`Unsupported Sieve comparator: ${String(argument.value)}`);
    }
  }
}

function validateVacation(node: Node): void {
  const allowed = new Set(["days", "subject", "handle"]);
  for (const argument of asNodes(node.args)) {
    const name = String(argument.name || "").toLowerCase();
    if (!allowed.has(name)) throw new SieveValidationError(`Unsupported vacation tag: :${name}`);
  }
  const plan = vacationPlan(node);
  if (!Number.isSafeInteger(plan.days) || plan.days < 1 || plan.days > 365) {
    throw new SieveValidationError("vacation :days must be between 1 and 365");
  }
  if (plan.handle.length > 128) throw new SieveValidationError("vacation :handle must not exceed 128 characters");
  if ((plan.subject?.length || 0) > 998) throw new SieveValidationError("vacation :subject must not exceed 998 characters");
  if (new TextEncoder().encode(plan.reason).byteLength > 32_768) throw new SieveValidationError("vacation reason must not exceed 32 KiB");
}

function executeCommands(commands: Node[], context: SieveContext): { plan: VacationPlan | null; stopped: boolean } {
  for (const command of commands) {
    if (command.type === "Require") continue;
    if (command.type === "Stop") return { plan: null, stopped: true };
    if (command.type === "Vacation") return { plan: vacationPlan(command), stopped: false };
    if (command.type === "If") {
      const branch = matchingBranch(command, context);
      if (!branch) continue;
      const result = executeCommands(asNodes(branch.commands), context);
      if (result.plan || result.stopped) return result;
    }
  }
  return { plan: null, stopped: false };
}

function matchingBranch(command: Node, context: SieveContext): Node | null {
  if (evaluateTest(asNode(command.test), context)) return asNode(command.block);
  for (const branch of asNodes(command.elseifs)) {
    if (evaluateTest(asNode(branch.test), context)) return asNode(branch.block);
  }
  return isNode(command.else) ? asNode(command.else).block as Node : null;
}

function evaluateTest(test: Node, context: SieveContext): boolean {
  switch (test.type) {
    case "TrueTest": return true;
    case "FalseTest": return false;
    case "NotTest": return !evaluateTest(asNode(test.test), context);
    case "AllofTest": return asNodes(test.tests).every((item) => evaluateTest(item, context));
    case "AnyofTest": return asNodes(test.tests).some((item) => evaluateTest(item, context));
    case "ExistsTest": return asStrings(test.headers).every((name) => context.headers[name.toLowerCase()] !== undefined);
    case "SizeTest": return String(test.qualifier) === "over" ? context.size > Number(test.size) : context.size < Number(test.size);
    case "HeaderTest": return matchValues(asStrings(test.headers).map((name) => context.headers[name.toLowerCase()] || ""), asStrings(test.keys), asNodes(test.args));
    case "EnvelopeTest": {
      const values = asStrings(test.parts).map((part) => part.toLowerCase() === "from" ? context.envelopeFrom : part.toLowerCase() === "to" ? context.envelopeTo : "");
      return matchValues(values, asStrings(test.keys), asNodes(test.args));
    }
    case "AddressTest": {
      const values = asStrings(test.headers).map((name) => context.headers[name.toLowerCase()] || "");
      return matchValues(values.map((value) => addressPart(value, tagName(asNodes(test.args), ["all", "localpart", "domain"]) || "all")), asStrings(test.keys), asNodes(test.args));
    }
    case "GenericTest": return evaluateGenericTest(test, context);
    default: throw new SieveValidationError(`Unsupported Sieve test: ${test.type}`);
  }
}

function evaluateGenericTest(test: Node, context: SieveContext): boolean {
  const name = String(test.name).toLowerCase();
  const args = asNodes(test.args);
  const first = args[0];
  const mode = first ? String(first.name).toLowerCase() : "is";
  const selector = first?.value === undefined ? "" : String(first.value);
  const keys = asStrings(test.arguments);
  const normalizedArgs: Node[] = [{ type: "TaggedArg", name: mode, value: null }];
  if (name === "envelope") {
    const value = selector.toLowerCase() === "from" ? context.envelopeFrom : selector.toLowerCase() === "to" ? context.envelopeTo : "";
    return matchValues([value], keys, normalizedArgs);
  }
  const value = context.headers[selector.toLowerCase()] || "";
  if (name === "header") return matchValues([value], keys, normalizedArgs);
  if (name === "address") return matchValues([addressPart(value, "all")], keys, normalizedArgs);
  throw new SieveValidationError(`Unsupported Sieve test: ${name}`);
}

function matchValues(values: string[], keys: string[], args: Node[]): boolean {
  const mode = tagName(args, ["is", "contains", "matches"]) || "is";
  const octet = String(tagValue(args, "comparator") ?? "").toLowerCase() === "i;octet";
  return values.some((value) => keys.some((key) => {
    const left = octet ? value : value.toLowerCase();
    const right = octet ? key : key.toLowerCase();
    if (mode === "contains") return left.includes(right);
    if (mode === "matches") return globMatches(left, right);
    return left === right;
  }));
}

function vacationPlan(node: Node): VacationPlan {
  const args = asNodes(node.args);
  return {
    kind: "vacation",
    days: Number(tagValue(args, "days") ?? 7),
    handle: String(tagValue(args, "handle") ?? "default"),
    subject: tagValue(args, "subject") === undefined ? null : String(tagValue(args, "subject")),
    reason: String(node.reason || ""),
  };
}

function normalizedContext(context: SieveContext): SieveContext {
  return {
    ...context,
    headers: Object.fromEntries(Object.entries(context.headers).map(([name, value]) => [name.toLowerCase(), value])),
  };
}

function addressPart(value: string, part: string): string {
  const match = /<?([^<>\s]+@[^<>\s]+)>?/.exec(value);
  const address = match?.[1] || value;
  const separator = address.lastIndexOf("@");
  if (part === "localpart") return separator < 0 ? address : address.slice(0, separator);
  if (part === "domain") return separator < 0 ? "" : address.slice(separator + 1);
  return address;
}

function globMatches(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

function tagName(args: Node[], names: string[]): string | undefined {
  return args.map((argument) => String(argument.name || "").toLowerCase()).find((name) => names.includes(name));
}

function tagValue(args: Node[], name: string): unknown {
  return args.find((argument) => String(argument.name || "").toLowerCase() === name)?.value;
}

function isNode(value: unknown): value is Node {
  return Boolean(value && typeof value === "object" && typeof (value as Node).type === "string");
}

function asNode(value: unknown): Node {
  if (!isNode(value)) throw new SieveValidationError("Malformed Sieve AST");
  return value;
}

function asNodes(value: unknown): Node[] {
  return Array.isArray(value) ? value.map(asNode) : [];
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : [];
}
