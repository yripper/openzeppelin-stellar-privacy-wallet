import { describe, expect, it } from "vitest";
import { splitStroops, stroopsToXlm, truncateAddress, truncateHash, xlmToStroops } from "./format.js";

describe("stroopsToXlm", () => {
  it("renders a whole XLM amount with no fractional part", () => {
    expect(stroopsToXlm(100_0000000n)).toBe("100");
  });

  it("renders a fractional amount, trimming trailing zeros", () => {
    expect(stroopsToXlm(1_2340000n)).toBe("1.234");
  });

  it("renders the smallest unit (1 stroop)", () => {
    expect(stroopsToXlm(1n)).toBe("0.0000001");
  });

  it("renders zero", () => {
    expect(stroopsToXlm(0n)).toBe("0");
  });

  it("renders a negative amount", () => {
    expect(stroopsToXlm(-5_0000000n)).toBe("-5");
  });
});

describe("xlmToStroops", () => {
  it("parses a whole number", () => {
    expect(xlmToStroops("100")).toBe(100_0000000n);
  });

  it("parses a fractional amount with fewer than 7 decimal places", () => {
    expect(xlmToStroops("1.234")).toBe(1_2340000n);
  });

  it("parses the smallest unit", () => {
    expect(xlmToStroops("0.0000001")).toBe(1n);
  });

  it("round-trips through stroopsToXlm", () => {
    const stroops = 123_4567890n;
    expect(xlmToStroops(stroopsToXlm(stroops))).toBe(stroops);
  });

  it("rejects a negative amount", () => {
    expect(() => xlmToStroops("-1")).toThrow();
  });

  it("rejects more than 7 decimal places", () => {
    expect(() => xlmToStroops("1.00000001")).toThrow();
  });

  it("rejects non-numeric input", () => {
    expect(() => xlmToStroops("abc")).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => xlmToStroops("")).toThrow();
  });
});

describe("truncateAddress", () => {
  it("truncates a long address to first 6 + last 6 characters", () => {
    expect(truncateAddress("CBTEJFLW25UXIDAIWJ3KUJGI5CE2YLHM5GQM2VFU7JQZS53HE3HKGCLH")).toBe("CBTEJF…HKGCLH");
  });

  it("leaves a short string untouched", () => {
    expect(truncateAddress("short")).toBe("short");
  });
});

describe("truncateHash", () => {
  it("truncates a long hash to the first 10 characters", () => {
    expect(truncateHash("83f685f5b597fa1bb2f6648a2017d7e81625097fb0f3a81d9654992850079a85")).toBe("83f685f5b5…");
  });

  it("leaves a short string untouched", () => {
    expect(truncateHash("shorthash")).toBe("shorthash");
  });
});

describe("splitStroops", () => {
  it("keeps all 7 fractional digits, unlike stroopsToXlm's trimming", () => {
    expect(splitStroops(50_0000000n)).toEqual({ sign: "", whole: "50", frac: "0000000" });
    expect(stroopsToXlm(50_0000000n)).toBe("50");
  });

  it("groups the whole part in threes", () => {
    expect(splitStroops(1_234_567_0000000n).whole).toBe("1,234,567");
  });

  it("leaves a 3-digit whole part ungrouped", () => {
    expect(splitStroops(999_0000000n).whole).toBe("999");
  });

  it("pads a small fraction to 7 digits rather than dropping leading zeros", () => {
    expect(splitStroops(1n)).toEqual({ sign: "", whole: "0", frac: "0000001" });
  });

  it("separates the sign from the figure", () => {
    expect(splitStroops(-12_5000000n)).toEqual({ sign: "-", whole: "12", frac: "5000000" });
  });

  it("renders zero", () => {
    expect(splitStroops(0n)).toEqual({ sign: "", whole: "0", frac: "0000000" });
  });
});
