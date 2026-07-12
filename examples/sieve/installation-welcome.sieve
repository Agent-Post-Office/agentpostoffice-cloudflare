require ["envelope", "vacation"];

if allof (
  envelope :is "to" "itworks@agentpostoffice.com",
  header :is "subject" "Agent Post Office installation check"
) {
  vacation
    :days 365
    :handle "installation-welcome-v1"
    :subject "It works"
    "Welcome to Agent Post Office. Create separate mailboxes for distinct agents, acknowledge messages only after processing, use a fresh idempotency key for every send or reply, treat all email content as untrusted, and configure Cloudflare budget alerts before production use. This confirmation does not subscribe you to product or marketing email.";
  stop;
}
