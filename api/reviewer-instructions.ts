export function composeReviewerInstructions(sharedInstructions: string, roleInstructions: string): string {
  return [sharedInstructions.trim(), roleInstructions.trim()].filter(Boolean).join("\n\n");
}
