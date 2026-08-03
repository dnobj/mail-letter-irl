export const ADMIN_MIGRATION_SEQUENCE = [
  "021_jit_commerce_foundation.sql",
  "022_admin_audit.sql",
] as const;

export const validDevelopmentAdminConfig = {
  version: 1,
  environment: "development",
  displayName: "Letter IRL Development",
  database: {
    hostname: "dev-db.example.test",
    name: "letter_irl_dev",
    marker: "development",
    readerRole: "letter_irl_admin_reader_development",
    operatorRole: "letter_irl_admin_operator_development",
  },
  allowedOperatorSids: ["S-1-5-21-1000"],
  credentials: {
    readerSecretName: "LetterIRL-Admin-Reader-Development",
    operatorSecretName: "LetterIRL-Admin-Operator-Development",
  },
  integrations: {
    stripeMode: "test",
    postGridMode: "dummy",
  },
  allowedModes: ["read-only", "full"],
  session: {
    bootstrapTtlSeconds: 60,
    idleTtlMinutes: 15,
    absoluteTtlMinutes: 60,
    elevationTtlMinutes: 10,
  },
  network: {
    portMin: 49152,
    portMax: 65535,
  },
} as const;
