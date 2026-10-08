/**
 * A visually hidden live region: screen readers read `message` politely whenever it changes (WCAG 4.1.3). It is always
 * in the page, so the first message is read too. To say the same words twice, change `count` (a zero-width difference).
 */
export function Status({ message, count = 0 }: { message: string; count?: number }) {
  return (
    <p role="status" className="sr-only">
      {message && message + (count % 2 ? "​" : "")}
    </p>
  );
}
