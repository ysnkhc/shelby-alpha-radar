import "dotenv/config";
import { z } from "zod";

/**
 * Environment variable schema.
 * Validates and types all required config at startup.
 * If any variable is missing or invalid, the app will fail fast with a clear error.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid connection string"),
  REDIS_URL: z.string().url("REDIS_URL must be a valid connection string"),
  SHELBY_RPC_URL: z.string().url("SHELBY_RPC_URL must be a valid URL"),
  APTOS_RPC_URL: z.string().url("APTOS_RPC_URL must be a valid URL"),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

/** Parsed & validated environment variables */
export type Env = z.infer<typeof envSchema>;

/**
 * Parse environment variables.
 * Throws a descriptive error if validation fails.
 */
function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("❌ Invalid environment variables:");
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const env: Env = loadEnv();
