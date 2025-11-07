import { LetterIrlServer } from "../server.js";

async function main() {
  const server = new LetterIrlServer();
  const userId = "dev-user";

  const letterInput = {
    sender: {
      name: "Casey Sender",
      addressLine1: "123 Main St",
      city: "Springfield",
      state: "IL",
      postalCode: "62701",
      country: "USA"
    },
    recipient: {
      name: "Alex Recipient",
      addressLine1: "500 Oak Ave",
      city: "Metropolis",
      state: "NY",
      postalCode: "10001",
      country: "USA"
    },
    bodyText: "Congratulations on your recent promotion! Looking forward to celebrating soon.",
    signOff: "Cheers, Casey"
  };

  console.log("\n--- Flow A: Quote and Send Letter ---");
  const preview = await server.execute<typeof letterInput, any>({
    toolName: "quote_and_preview_letter",
    input: letterInput,
    userId
  });
  console.log("Preview canSendNow:", preview.result.canSendNow);
  console.log("Required credits:", preview.result.requiredCredits);

  const send = await server.execute({
    toolName: "send_letter",
    input: {
      ...letterInput,
      requiredCredits: preview.result.requiredCredits,
      confirm: true
    },
    userId
  });
  console.log("Order queued:", send.result.orderId);

  console.log("\n--- Flow B: Check Status ---");
  const status = await server.execute({
    toolName: "get_order_status",
    input: {},
    userId
  });
  console.log("Latest status:", status.result.currentStatus);

  console.log("\n--- Flow C: Check Balance ---");
  const balance = await server.execute({
    toolName: "get_account_balance",
    input: {},
    userId
  });
  console.log("Credits remaining:", balance.result.creditsRemaining);
}

main().catch((error) => {
  console.error("Flow harness failed:", error);
  process.exitCode = 1;
});
