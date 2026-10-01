import { describe, expect, it } from "vitest";
import {
  getPriceImpactSeverity,
  getPriceImpactSeverityFromBps,
  validateSlippage,
} from "./slippage";

describe("slippage & price impact helpers", () => {
  describe("getPriceImpactSeverity", () => {
    it("returns 'safe' for price impact < 2%", () => {
      expect(getPriceImpactSeverity(0)).toBe("safe");
      expect(getPriceImpactSeverity(0.5)).toBe("safe");
      expect(getPriceImpactSeverity(1.0)).toBe("safe");
      expect(getPriceImpactSeverity(1.99)).toBe("safe");
      expect(getPriceImpactSeverity(-1.5)).toBe("safe");
    });

    it("returns 'warn' for price impact between 2% and 10%", () => {
      expect(getPriceImpactSeverity(2.0)).toBe("warn");
      expect(getPriceImpactSeverity(3.2)).toBe("warn");
      expect(getPriceImpactSeverity(9.99)).toBe("warn");
    });

    it("returns 'danger' for price impact >= 10%", () => {
      expect(getPriceImpactSeverity(10.0)).toBe("danger");
      expect(getPriceImpactSeverity(12.5)).toBe("danger");
      expect(getPriceImpactSeverity(25.0)).toBe("danger");
    });
  });

  describe("getPriceImpactSeverityFromBps", () => {
    it("correctly scales basis points to percentage bands", () => {
      expect(getPriceImpactSeverityFromBps(50)).toBe("safe"); // 0.5%
      expect(getPriceImpactSeverityFromBps(199)).toBe("safe"); // 1.99%
      expect(getPriceImpactSeverityFromBps(200)).toBe("warn"); // 2.0%
      expect(getPriceImpactSeverityFromBps(999)).toBe("warn"); // 9.99%
      expect(getPriceImpactSeverityFromBps(1000)).toBe("danger"); // 10.0%
      expect(getPriceImpactSeverityFromBps(1200)).toBe("danger"); // 12.0%
    });
  });

  describe("validateSlippage", () => {
    it("rejects slippage < 0.01%", () => {
      const res = validateSlippage(0.005);
      expect(res.valid).toBe(false);
      expect(res.warning).toBe("Slippage too low");
    });

    it("rejects slippage > 50%", () => {
      const res = validateSlippage(51);
      expect(res.valid).toBe(false);
      expect(res.warning).toBe("Slippage too high");
    });

    it("warns for high slippage > 1%", () => {
      const res = validateSlippage(2.5);
      expect(res.valid).toBe(true);
      expect(res.warning).toContain("High slippage");
    });

    it("accepts normal slippage without warning", () => {
      const res = validateSlippage(0.5);
      expect(res.valid).toBe(true);
      expect(res.warning).toBeUndefined();
    });
  });
});
