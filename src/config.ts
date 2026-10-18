import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
    DATABASE_URL: z
        .string()
        .url()
        .refine(
            (value) => /^postgres(ql)?:\/\//.test(value),
            "DATABASE_URL must be a PostgreSQL connection URL",
        ),

    DB_CONNECTION_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(1000)
        .max(120000)
        .default(10000),

    NETWORK_ATTEMPT_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(10)
        .max(10000)
        .default(2000),

    PACKET_MAX_AGE_HOURS: z.coerce
        .number()
        .int()
        .min(1)
        .max(168)
        .default(24),

    ARCJET_MODE: z
        .enum(["OFF", "DRY_RUN", "LIVE"])
        .default("OFF"),

    ARCJET_KEY: z.string().trim().min(1).max(256).optional(),

    PORT: z.coerce.number().int().min(1).max(65535).default(8080),

    NODE_ENV: z
        .enum(["development", "test", "production"])
        .default("development"),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
    console.error("Invalid environment configuration:");

    for (const issue of result.error.issues) {
        console.error(`- ${issue.path.join(".")}: ${issue.message}`);
    }

    process.exit(1);
}

if (
    result.data.ARCJET_MODE !== "OFF" &&
    !result.data.ARCJET_KEY
) {
    console.error(
        "ARCJET_KEY is required when ARCJET_MODE is enabled.",
    );
    process.exit(1);
}

export const config = result.data;