import 'dotenv/config';
import * as joi from 'joi';

interface EnvVars {
    PORT: number;
    RABBITMQ_SERVERS: string[];
    // REDIS_HOST: string;
    // REDIS_PORT: number;
    // REDIS_PASSWORD: string;
    // REDIS_USERNAME?: string;
    CIRCUIT_BREAKER_THRESHOLD?: number;
    CIRCUIT_BREAKER_TIMEOUT?: number;
}

const envsSchema = joi.object({
    PORT: joi.number().required(),
    RABBITMQ_SERVERS: joi.array().items(joi.string()).required(),
    // REDIS_HOST: joi.string().required(),
    // REDIS_PORT: joi.number().default(6379),
    // REDIS_PASSWORD: joi.string().required(),
    // REDIS_USERNAME: joi.string().optional(),
    CIRCUIT_BREAKER_THRESHOLD: joi.number().default(5),
    CIRCUIT_BREAKER_TIMEOUT: joi.number().default(30000),
})
.unknown(true);

const { error, value } = envsSchema.validate({
  ...process.env,
  RABBITMQ_SERVERS: process.env.RABBITMQ_SERVERS?.split(',') || [],
  REDIS_PORT: parseInt(process.env.REDIS_PORT || '6379'),
    CIRCUIT_BREAKER_THRESHOLD: parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || '5'),
    CIRCUIT_BREAKER_TIMEOUT: parseInt(process.env.CIRCUIT_BREAKER_TIMEOUT || '30000'),
});

if (error) {
    throw new Error(`Config validation error: ${error.message}`);
}

const envVars: EnvVars = value;

export const envs = {
    port: envVars.PORT,
    rabbitmqServers: envVars.RABBITMQ_SERVERS,
    redis: {
        url: process.env.REDIS_URL, // Añadir soporte para URL completa
        // host: envVars.REDIS_HOST,
        // port: envVars.REDIS_PORT,
        // password: envVars.REDIS_PASSWORD,
        // username: envVars.REDIS_USERNAME,
    },
    circuitBreaker: {
        threshold: envVars.CIRCUIT_BREAKER_THRESHOLD,
        timeout: envVars.CIRCUIT_BREAKER_TIMEOUT,
    }
}

