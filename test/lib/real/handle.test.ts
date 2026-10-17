import { describe, expect, it } from "vitest";
import { HANDLE_MAX_LENGTH, HANDLE_MIN_LENGTH, HANDLE_PATTERN, RESERVED_HANDLES, canonicalizeHandle, formatHandle, isReservedHandle } from "@/lib/real/handle";

const ok = (input: unknown) => {
  const result = canonicalizeHandle(input);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(input)} to be accepted: ${result.reason}`);
  return result.handle;
};
const refused = (input: unknown) => expect(canonicalizeHandle(input).ok, JSON.stringify(input)).toBe(false);

describe("canonicalizeHandle — the one handle validator", () => {
  it("accepts the canonical form unchanged", () => {
    for (const handle of ["smit", "abc", "a1b2", "maya_chen", "a_b_c", "x9_9x", "a".repeat(20)]) expect(ok(handle)).toBe(handle);
  });

  it("canonicalizes uppercase ASCII to lowercase", () => {
    expect(ok("Smit")).toBe("smit");
    expect(ok("MAYA_Chen9")).toBe("maya_chen9");
  });

  it("removes exactly ONE leading @ — never two, never one elsewhere", () => {
    expect(ok("@smit")).toBe("smit");
    refused("@@smit");
    refused("@ smit");
    refused("smit@");
    refused("sm@it");
    refused("@");
  });

  it("trims surrounding ASCII whitespace only; anything left inside or after is refused", () => {
    expect(ok("  smit  ")).toBe("smit");
    expect(ok("\tsmit\n")).toBe("smit");
    expect(ok(" @smit\r\n")).toBe("smit");
    refused("smit\nadmin"); // newline + trailing junk
    refused("smit\n\nx");
    refused("smit x");
    refused("smit\u0000");
    refused("smit;--");
    refused("smit/../x");
  });

  it("does not treat Unicode spaces as trimmable — they are non-ASCII and refused", () => {
    refused("\u00A0smit");
    refused("smit\u2003");
    refused("\uFEFFsmit");
  });

  it("rejects every non-ASCII code point BEFORE lowercasing — nothing can case-fold into ASCII", () => {
    // U+212A KELVIN SIGN lowercases to ASCII "k"; U+0130 lowercases to "i" + U+0307.
    expect("\u212A".toLowerCase()).toBe("k");
    refused("\u212Aevin");
    refused("smit\u212A");
    refused("\u0130stanbul");
    refused("sm\u0130t");
    // U+017F LATIN SMALL LETTER LONG S uppercases to "S"; still non-ASCII.
    refused("\u017Fmit");
  });

  it("rejects fullwidth Latin (which NFKC would fold to ASCII — NFKC is never applied)", () => {
    expect("\uFF53\uFF4D\uFF49\uFF54".normalize("NFKC")).toBe("smit");
    refused("\uFF53\uFF4D\uFF49\uFF54");
    refused("smi\uFF54");
  });

  it("rejects Cyrillic and Greek look-alikes", () => {
    refused("\u0430dmin"); // Cyrillic \u0430
    refused("p\u0430y"); // Cyrillic \u0430 inside
    refused("\u0441\u043C\u0456\u0442");
    refused("\u03BFmega"); // Greek omicron
  });

  it("rejects combining marks, emoji, and astral code points", () => {
    refused("smit\u0301");
    refused("smit\u{1F600}");
    refused("\u{1D42C}mit");
  });

  it("enforces the length boundaries on the canonical form", () => {
    expect(HANDLE_MIN_LENGTH).toBe(3);
    expect(HANDLE_MAX_LENGTH).toBe(20);
    refused("");
    refused("a");
    refused("ab");
    expect(ok("abc")).toBe("abc");
    expect(ok("a".repeat(20))).toBe("a".repeat(20));
    refused("a".repeat(21));
    // The @ and surrounding whitespace don't count.
    expect(ok(` @${"a".repeat(20)} `)).toBe("a".repeat(20));
    refused("@ab");
  });

  it("enforces the underscore rules: not first, not last, never consecutive", () => {
    refused("_smit");
    refused("smit_");
    refused("sm__it");
    refused("s___t");
    refused("___");
    expect(ok("s_m_i_t")).toBe("s_m_i_t");
  });

  it("must start with a letter — so nothing numeric and nothing address-shaped", () => {
    refused("1smit");
    refused("123");
    refused("9_a");
    refused("0x1234");
    refused("0xd9a4c22fb34dc74317edc8006140d66c8fa03266");
    refused("0Xabc");
  });

  it("rejects every other ASCII character", () => {
    for (const bad of ["sm-it", "sm.it", "sm it", "smit!", "sm+it", "smit'", 'sm"it', "sm<it", "sm%it", "sm\\it"]) refused(bad);
  });

  it("rejects non-strings", () => {
    for (const bad of [null, undefined, 42, {}, [], true, ["smit"]]) refused(bad);
  });

  it("is idempotent and its output always satisfies the canonical regex", () => {
    for (const input of ["Smit", "@Maya_Chen", "  a1b2 ", "ABC"]) {
      const once = ok(input);
      expect(ok(once)).toBe(once);
      expect(HANDLE_PATTERN.test(once)).toBe(true);
    }
    expect(HANDLE_PATTERN.source).toBe("^[a-z][a-z0-9]*(_[a-z0-9]+)*$");
  });

  it("ASCII look-alikes are accepted, not folded: l/1 and o/0 stay distinct handles", () => {
    expect(ok("pau1")).toBe("pau1");
    expect(ok("paul")).toBe("paul");
    expect(ok("b0b")).not.toBe(ok("bob"));
  });

  it("formatHandle shows the canonical handle with its @", () => {
    expect(formatHandle("smit")).toBe("@smit");
  });
});

describe("reserved handles", () => {
  const REQUIRED = [
    "admin", "administrator", "support", "help", "security", "official", "staff", "team", "system", "root", "moderator", "api", "app", "null",
    "undefined", "anonymous", "me", "everyone", "onchain", "onchainfinance", "on_chain_finance", "cash", "pay", "save", "invest", "swap", "borrow",
    "explore", "home", "real", "practice", "bank", "turnkey", "safe", "base", "coinbase", "circle", "usdc", "pimlico", "wallet", "account",
    "settings", "login", "register",
  ];

  it("contains at least the required set, deduplicated", () => {
    for (const name of REQUIRED) expect(isReservedHandle(name), name).toBe(true);
    expect(new Set(RESERVED_HANDLES).size).toBe(RESERVED_HANDLES.length);
  });

  it("every reserved name is canonical — except the deliberately short 'me', which is unclaimable by length anyway", () => {
    for (const name of RESERVED_HANDLES) {
      if (name === "me") {
        expect(canonicalizeHandle(name).ok).toBe(false);
        continue;
      }
      expect(canonicalizeHandle(name), name).toEqual({ ok: true, handle: name });
    }
  });

  it("canonicalization is what makes a reserved name reachable in any spelling", () => {
    expect(isReservedHandle(ok("@Admin"))).toBe(true);
    expect(isReservedHandle(ok(" SUPPORT "))).toBe(true);
    expect(isReservedHandle("smit")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge trimming: linear replacement vs. the original regular expression.
// ---------------------------------------------------------------------------

/**
 * The ORIGINAL canonicalizer, kept verbatim as a reference oracle. It is only
 * ever fed short, bounded inputs: its trailing alternative is quadratic on
 * long whitespace runs, which is exactly what the production code no longer does.
 */
const REFERENCE_EDGES = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;
function referenceCanonicalize(input: unknown): ReturnType<typeof canonicalizeHandle> {
  if (typeof input !== "string") return { ok: false, reason: "Enter a name." };
  const trimmed = input.replace(REFERENCE_EDGES, "");
  const bare = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (bare.length === 0) return { ok: false, reason: "Enter a name." };
  if (/[^\x00-\x7F]/.test(bare)) return { ok: false, reason: "Use only letters a–z, numbers, and underscores." };
  const handle = bare.toLowerCase();
  if (!/^[a-z0-9_]+$/.test(handle)) return { ok: false, reason: "Use only letters a–z, numbers, and underscores." };
  if (handle.length < HANDLE_MIN_LENGTH) return { ok: false, reason: `Use at least ${HANDLE_MIN_LENGTH} characters.` };
  if (handle.length > HANDLE_MAX_LENGTH) return { ok: false, reason: `Use ${HANDLE_MAX_LENGTH} characters or fewer.` };
  if (!/^[a-z]/.test(handle)) return { ok: false, reason: "Start with a letter." };
  if (!HANDLE_PATTERN.test(handle)) return { ok: false, reason: "Underscores can't be first, last, or next to each other." };
  return { ok: true, handle };
}

const sameAsReference = (input: unknown) => expect(canonicalizeHandle(input), JSON.stringify(input)).toEqual(referenceCanonicalize(input));

describe("canonicalizeHandle \u2014 equivalence with the original edge-trimming regex", () => {
  it("matches the reference on hand-picked boundary inputs, including the exact result strings", () => {
    const cases: unknown[] = [
      "", " ", "\t", "\n", "\r", "\f", "\v", "   ", " \t\n\r\f\v ", "@", " @ ", "@@", "@ smit", " @smit ", "@smit\r\n",
      "smit", "  smit", "smit  ", "  smit  ", "\t\n smit \v\f\r", "sm it", "sm\tit", "sm\nit", "smit \n x", "a  b",
      "abc", "ab", " ab ", "a".repeat(20), "a".repeat(21), ` ${"a".repeat(20)} `, ` ${"a".repeat(21)} `, ` @${"a".repeat(20)} `,
      "\u00A0smit", "smit\u00A0", "\u2003smit\u2003", "\uFEFFsmit", "\u200Bsmit", "smit\u200B", "sm\u200Bit", " \u200B ", "\u2028smit", "smit\u2029",
      "\u0085smit", "\u180Esmit", "\u212Aevin", "\u0130stanbul", "smit\u{1F600}", "\u{1F600}", " \u{1F600} ", "\uD83D", "smit\uDE00", "\u{1F600}smit",
      "\u0000smit", "smit\u0000", "\u001Fsmit", "\u001Csmit", "_smit", "smit_", "sm__it", " _a_ ", " s_m_i_t ", "1smit", " 0x1234 ",
      "Smit", " MAYA_Chen9\n", "sm-it", "smit;--", "smit\nadmin", "\n\nsmit\n\n",
    ];
    for (const input of cases) sameAsReference(input);
    // Spot-check literal outputs too, so the oracle cannot silently drift with the implementation.
    expect(canonicalizeHandle("\t\n smit \v\f\r")).toEqual({ ok: true, handle: "smit" });
    expect(canonicalizeHandle(" @Smit ")).toEqual({ ok: true, handle: "smit" });
    expect(canonicalizeHandle("   ")).toEqual({ ok: false, reason: "Enter a name." });
    expect(canonicalizeHandle(" @ ")).toEqual({ ok: false, reason: "Enter a name." });
    expect(canonicalizeHandle("\u00A0smit")).toEqual({ ok: false, reason: "Use only letters a–z, numbers, and underscores." });
    expect(canonicalizeHandle("sm it")).toEqual({ ok: false, reason: "Use only letters a–z, numbers, and underscores." });
  });

  // All 65 536 UTF-16 code units, split into four independent partitions so each test stays well inside the default
  // timeout even on a loaded machine. The partitions are contiguous, disjoint, and together cover 0x0000-0xFFFF exactly
  // (the last test asserts that).
  const SWEEP_PARTITIONS = [
    { name: "0x0000-0x3FFF", from: 0x0000, to: 0x3fff },
    { name: "0x4000-0x7FFF", from: 0x4000, to: 0x7fff },
    { name: "0x8000-0xBFFF", from: 0x8000, to: 0xbfff },
    { name: "0xC000-0xFFFF (includes all surrogates)", from: 0xc000, to: 0xffff },
  ] as const;

  for (const { name, from, to } of SWEEP_PARTITIONS) {
    it(`matches the reference for every UTF-16 code unit in ${name} as leading and as trailing padding`, () => {
      for (let code = from; code <= to; code += 1) {
        const unit = String.fromCharCode(code);
        sameAsReference(`${unit}smit`);
        sameAsReference(`smit${unit}`);
        sameAsReference(`${unit}${unit}smit${unit}${unit}`);
        sameAsReference(unit);
      }
    });
  }

  it("the UTF-16 sweep partitions are disjoint and cover every code unit exactly once", () => {
    let expectedNext = 0;
    for (const { from, to } of SWEEP_PARTITIONS) {
      expect(from).toBe(expectedNext);
      expect(to).toBeGreaterThanOrEqual(from);
      expectedNext = to + 1;
    }
    expect(expectedNext).toBe(0x10000);
  });

  it("trims exactly the six ASCII whitespace characters and nothing else", () => {
    for (const ws of [" ", "\t", "\n", "\v", "\f", "\r"]) expect(ok(`${ws}${ws}smit${ws}${ws}`)).toBe("smit");
    // The code points String.prototype.trim would remove (or that sit next to the ASCII range) must NOT be trimmed.
    for (const notWs of ["\u0008", "\u000E", "\u001F", "!", "\u00A0", "\u1680", "\u2000", "\u2028", "\u2029", "\u202F", "\u205F", "\u3000", "\uFEFF", "\u0085", "\u200B"]) {
      refused(`${notWs}smit`);
      refused(`smit${notWs}`);
    }
  });

  // Special characters built from code units so the source stays readable and nothing invisible hides in it.
  const NBSP = String.fromCharCode(0x00a0);
  const ZWSP = String.fromCharCode(0x200b);
  const LONE_HIGH_SURROGATE = String.fromCharCode(0xd83d);

  const walkAll = (alphabet: readonly string[], maxLength: number) => {
    const walk = (prefix: string, remaining: number) => {
      sameAsReference(prefix);
      if (remaining === 0) return;
      for (const symbol of alphabet) walk(prefix + symbol, remaining - 1);
    };
    walk("", maxLength);
  };

  it("matches the reference exhaustively over every string up to length 4 on a mixed alphabet", () => {
    // Each ASCII whitespace kind, "@", both letter cases, a digit, "_", NBSP, a zero-width space, and a lone surrogate.
    walkAll([" ", "\t", "\n", "\v", "\f", "\r", "@", "a", "B", "1", "_", NBSP, ZWSP, LONE_HIGH_SURROGATE], 4);
  });

  it("matches the reference exhaustively over every string up to length 5 on a reduced alphabet", () => {
    // One representative per class: ASCII whitespace, "@", a letter, "_", a non-ASCII space, a zero-width character.
    walkAll([" ", "\n", "@", "a", "_", NBSP, ZWSP], 5);
  });

  // Fixed-seed corpus: exactly 6 000 strings of length 5-12 over the full mixed alphabet. The generator is mulberry32,
  // which mixes all 32 bits; an earlier power-of-two LCG used its low bits, which are periodic, and produced almost
  // only length-7 strings. Same seed, same corpus, every run.
  const SAMPLE_ALPHABET = [" ", "\t", "\n", "\v", "\f", "\r", "@", "a", "B", "1", "_", NBSP, ZWSP, LONE_HIGH_SURROGATE] as const;
  const buildLongerSample = (): string[] => {
    let state = 0x2f6e2b1;
    const random = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (count: number) => Math.floor(random() * count);
    const corpus: string[] = [];
    for (let i = 0; i < 6000; i += 1) {
      const length = 5 + pick(8);
      let input = "";
      for (let j = 0; j < length; j += 1) input += SAMPLE_ALPHABET[pick(SAMPLE_ALPHABET.length)];
      corpus.push(input);
    }
    return corpus;
  };

  it("matches the reference on a fixed-seed sample of longer mixed strings (length 5-12)", () => {
    for (const input of buildLongerSample()) sameAsReference(input);
  });

  it("the fixed-seed sample is reproducible and actually diverse (lengths, first symbols, adjacent pairs, whitespace shapes)", () => {
    const corpus = buildLongerSample();
    expect(buildLongerSample()).toEqual(corpus);
    expect(corpus).toHaveLength(6000);

    // Every length 5-12 occurs, none is a sliver of the corpus (6 000 / 8 = 750 expected per length).
    const byLength = new Map<number, number>();
    for (const input of corpus) byLength.set(input.length, (byLength.get(input.length) ?? 0) + 1);
    expect([...byLength.keys()].sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    for (const count of byLength.values()) expect(count).toBeGreaterThanOrEqual(500);

    // Every symbol appears, and every symbol appears in the first position.
    const seen = new Set(corpus.join(""));
    const firsts = new Set(corpus.map((input) => input[0]));
    for (const symbol of SAMPLE_ALPHABET) {
      expect(seen.has(symbol), JSON.stringify(symbol)).toBe(true);
      expect(firsts.has(symbol), JSON.stringify(symbol)).toBe(true);
    }

    // Every one of the 14 x 14 = 196 ordered adjacent pairs occurs.
    const pairs = new Set<string>();
    for (const input of corpus) for (let i = 0; i + 1 < input.length; i += 1) pairs.add(input.slice(i, i + 2));
    expect(pairs.size).toBe(SAMPLE_ALPHABET.length ** 2);

    // The shapes the trimmer cares about: leading, trailing, internal and repeated ASCII whitespace.
    const asciiWs = /[ \t\n\v\f\r]/;
    const leading = corpus.filter((input) => asciiWs.test(input[0]!));
    const trailing = corpus.filter((input) => asciiWs.test(input[input.length - 1]!));
    const internal = corpus.filter((input) => /\S[ \t\n\v\f\r]+\S/.test(input));
    const repeated = corpus.filter((input) => /[ \t\n\v\f\r]{2}/.test(input));
    const wholeStringWhitespace = corpus.filter((input) => /^[ \t\n\v\f\r]+$/.test(input));
    for (const group of [leading, trailing, internal, repeated]) expect(group.length).toBeGreaterThanOrEqual(500);
    expect(wholeStringWhitespace.length).toBeGreaterThanOrEqual(1);
  });

  it("matches the reference on padded handles at the minimum and maximum lengths and on mixed whitespace runs", () => {
    const runs = ["", " ", "  ", "\t", " \t\n", "\r\n\r\n", " \v\f ", " ".repeat(50), "\n".repeat(50), " \t".repeat(25)];
    const cores = ["abc", "ab", "a".repeat(20), "a".repeat(21), "@abc", "@a_b", "a b", "a\tb", "a_", "_a", "a\u200Bb", "a\u{1F600}b", "@@abc"];
    for (const left of runs) for (const core of cores) for (const right of runs) sameAsReference(`${left}${core}${right}`);
  });

  it("matches the reference on the adversarial shapes at bounded sizes", () => {
    for (const n of [0, 1, 2, 3, 19, 20, 21, 22, 100, 1000, 3000]) {
      const pad = " ".repeat(n);
      sameAsReference(`a${pad}a`);
      sameAsReference(`${pad}abc`);
      sameAsReference(`abc${pad}`);
      sameAsReference(`${pad}abc${pad}`);
      sameAsReference(`${pad}`);
      sameAsReference(`${pad}@${pad}`);
      sameAsReference(`a${pad}\u200B${pad}a`);
      sameAsReference(`a${"\t \n".repeat(n)}a`);
    }
  });
});

describe("canonicalizeHandle \u2014 no quadratic work on long whitespace runs", () => {
  // The original regex took ~0.25 s at 20 000 characters and ~4.5 s at 80 000 on a developer machine,
  // growing about 4x per doubling. At these sizes it would take minutes; a linear scan takes milliseconds.
  // The bound is deliberately loose (CI noise, cold JIT) yet still orders of magnitude below the old behavior.
  const SIZE = 1_000_000;
  const BUDGET_MS = 2_000;

  const timed = (input: string) => {
    const start = performance.now();
    const result = canonicalizeHandle(input);
    return { result, elapsed: performance.now() - start };
  };

  it('refuses "a" + spaces + "a" in linear time, with the same reason as before', () => {
    const { result, elapsed } = timed(`a${" ".repeat(SIZE)}a`);
    expect(result).toEqual({ ok: false, reason: "Use only letters a–z, numbers, and underscores." });
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it("handles leading-only, trailing-only and both-ended padding in linear time", () => {
    for (const pad of [" ", "\t", "\n", "\r", " \t\n\r\f\v"]) {
      const run = pad.repeat(Math.ceil(SIZE / pad.length));
      for (const [input, expected] of [
        [`${run}smit`, { ok: true, handle: "smit" }],
        [`smit${run}`, { ok: true, handle: "smit" }],
        [`${run}@smit${run}`, { ok: true, handle: "smit" }],
      ] as const) {
        const { result, elapsed } = timed(input);
        expect(result).toEqual(expected);
        expect(elapsed).toBeLessThan(BUDGET_MS);
      }
    }
  });

  it("handles all-whitespace and whitespace-around-a-non-trimmable-character in linear time", () => {
    for (const input of [" ".repeat(SIZE), `${" ".repeat(SIZE)}@${" ".repeat(SIZE)}`, `a${" ".repeat(SIZE)}\u00A0${" ".repeat(SIZE)}a`, `\u00A0${" ".repeat(SIZE)}`]) {
      const { elapsed } = timed(input);
      expect(elapsed).toBeLessThan(BUDGET_MS);
    }
    expect(canonicalizeHandle(" ".repeat(SIZE))).toEqual({ ok: false, reason: "Enter a name." });
  });

  it("stays inside the fixed time budget at every size on a growth ladder", () => {
    // This asserts an absolute budget at each size, not a growth rate (a ratio check would be flaky). The budget is
    // one the quadratic regex exceeds by orders of magnitude at the larger rungs.
    for (const size of [10_000, 40_000, 160_000, 640_000]) {
      const { elapsed } = timed(`a${" ".repeat(size)}a`);
      expect(elapsed).toBeLessThan(BUDGET_MS);
    }
  });
});
