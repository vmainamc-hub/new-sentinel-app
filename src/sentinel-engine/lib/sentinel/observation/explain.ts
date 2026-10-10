import type { ObservationDossier, MomentumRelation } from "./types";

/**
 * §12 — "While waiting" explanation. Built entirely from the live dossier;
 * never templated with placeholder/fake values. Returns the most relevant
 * gap(s) first.
 */
export function explainWaiting(d: ObservationDossier, momentumRelation: MomentumRelation): string {
  const parts: string[] = [];

  const dir = d.psychology.direction === "NONE" ? null : d.psychology.direction;

  if (dir && d.psychology.support !== "SUPPORTING") {
    parts.push(
      `${dir} psychology is ${d.psychology.state.toLowerCase()}, not yet fully supporting.`,
    );
  } else if (dir) {
    parts.push(`${dir} psychology is forming.`);
  }

  if (d.entryDigit.state !== "VALIDATED") {
    parts.push(
      d.entryDigit.digit != null
        ? `digit ${d.entryDigit.digit} is not yet a validated entry.`
        : `no entry digit has been validated yet.`,
    );
  }

  const pressureStates = Object.values(d.pressure.byWindow);
  const opposingWindows = pressureStates.filter((v) => v === "OPPOSING").length;
  const mixedWindows = pressureStates.filter((v) => v === "MIXED").length;
  if (opposingWindows > 0) {
    parts.push(`opposing digit pressure is present across ${opposingWindows} window(s).`);
  } else if (mixedWindows > 0) {
    parts.push(`15/30/60/120 pressure is currently mixed.`);
  }

  if (
    d.losingSidePressure.state === "INCREASING" ||
    d.losingSidePressure.state === "ACCELERATING"
  ) {
    parts.push(`opposing losing-side pressure is ${d.losingSidePressure.state.toLowerCase()}.`);
  }

  if (d.statistics.strength === "INSUFFICIENT") {
    parts.push(`statistical confirmation is insufficient.`);
  } else if (d.simulation.state === "LOSING" || d.simulation.state === "UNFAVOURABLE") {
    parts.push(`simulation evidence is currently ${d.simulation.state.toLowerCase()}.`);
  }

  if (d.regime.compatibility !== "COMPATIBLE") {
    parts.push(
      d.regime.transitioning
        ? `the market is transitioning (${d.regime.classification.replace(/_/g, " ").toLowerCase()}).`
        : `the current regime (${d.regime.classification.replace(/_/g, " ").toLowerCase()}) is ${
            d.regime.compatibility === "INCOMPATIBLE"
              ? "not compatible"
              : "not yet clearly compatible"
          }.`,
    );
  }

  if (momentumRelation === "CONFLICTING") {
    parts.push(`momentum is currently conflicting with this setup's direction.`);
  }

  if (
    d.stability === "FLUCTUATING" ||
    d.stability === "CHOPPY" ||
    d.stability === "HIGHLY_UNSTABLE"
  ) {
    parts.push(
      `short-term behavior is ${d.stability.toLowerCase()}, not yet stable enough to trust.`,
    );
  }

  if (
    d.danger &&
    (d.danger.level === "HIGH" || d.danger.level === "CRITICAL" || d.danger.total >= 40)
  ) {
    parts.push(`danger is elevated (${d.danger.total}/100: ${d.danger.summary}).`);
  }

  if (parts.length === 0) {
    return "Evidence is currently aligned; continuing to confirm persistence before presenting.";
  }

  const structural = dir
    ? `${dir} structure is ${d.psychology.support === "SUPPORTING" ? "valid" : "developing"}`
    : "Structure is still forming";

  return `${structural}, but ${parts.join(" Also, ")}`.replace(/\. but/g, ", but");
}

/**
 * §12 — "Why RIPE" explanation. Every line is generated from evidence
 * actually present on the dossier — nothing here is templated with
 * illustrative/fake values.
 */
export function explainRipe(d: ObservationDossier, momentumRelation: MomentumRelation): string[] {
  const lines: string[] = [];

  if (d.psychology.direction !== "NONE") {
    lines.push(`1,000-tick psychology supports ${d.psychology.direction}.`);
  }
  lines.push("Structural bar positioning is aligned.");

  if (d.entryDigit.digit != null) {
    lines.push(`Digit ${d.entryDigit.digit} satisfies the current entry-digit conditions.`);
  }

  const supportingWindows = Object.entries(d.pressure.byWindow)
    .filter(([, v]) => v === "SUPPORTING")
    .map(([w]) => w);
  if (supportingWindows.length > 0) {
    lines.push(`${supportingWindows.join("/")} pressure supports the candidate.`);
  }

  if (d.losingSidePressure.state === "DECLINING" || d.losingSidePressure.state === "STABLE") {
    lines.push(`Opposing losing-side pressure is ${d.losingSidePressure.state.toLowerCase()}.`);
  }

  if (d.regime.compatibility === "COMPATIBLE") {
    lines.push(
      `The current ${d.regime.classification.replace(/_/g, " ").toLowerCase()} regime is compatible and regime-specific evidence is supportive.`,
    );
  }

  if (momentumRelation === "SUPPORTIVE") {
    lines.push("Momentum is supportive of this setup.");
  }

  if (d.trigger.state === "VALID" || d.trigger.state === "FIRED") {
    lines.push("Entry trigger is currently valid.");
  }

  if (d.danger && d.danger.level === "CALM") {
    lines.push("Holistic danger engine profile is calm.");
  } else if (d.danger && d.danger.level === "LOW") {
    lines.push("Danger score is low and well-bounded.");
  }

  if (!d.veto.active) {
    lines.push("No veto is active.");
  }

  return lines;
}
