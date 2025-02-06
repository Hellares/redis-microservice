// import { RedisOptions } from 'ioredis';
// import { envs } from './envs';

import { RedisOptions } from "ioredis";

// export const redisConfig: RedisOptions = {
//   host: envs.redis.host,
//   port: envs.redis.port,
//   username: envs.redis.username,
//   password: envs.redis.password,
//   connectTimeout: 5000,     // 5 segundos máximo para conectar
//   commandTimeout: 3000,     // 3 segundos máximo por comando
//   maxRetriesPerRequest: 3,  // Reducir reintentos
//   retryStrategy: (times: number) => {
//     if (times > 3) {
//       return null; // Dejar de reintentar después de 3 veces
//     }
//     const delay = Math.min(times * 1000, 3000);
//     return delay;
//   },
//   enableReadyCheck: false,  // Deshabilitar para conexiones más rápidas
//   lazyConnect: true
// };

//! arriba para conexion local 

// export const redisConfig: RedisOptions = {
//   connectTimeout: 5000,
//   commandTimeout: 3000,
//   maxRetriesPerRequest: 3,
//   retryStrategy: (times: number) => {
//     if (times > 3) {
//       return null;
//     }
//     const delay = Math.min(times * 1000, 3000);
//     return delay;
//   },
//   enableReadyCheck: false,
//   lazyConnect: true
// };

//? arriba con conexion a redis en railway - sin compresión

export interface CompressionConfig {
  enabled: boolean;
  threshold: number; // Tamaño mínimo en bytes para comprimir
  level: number; // Nivel de compresión (1-9, donde 9 es máxima compresión)
}

export interface RedisConfigWithCompression extends RedisOptions {
  compression: CompressionConfig;
}

export const compressionConfig: CompressionConfig = {
  enabled: true,
  threshold: 5120, // Comprimir solo datos mayores a 1KB
  level: 4 // Balance entre velocidad y compresión
};

// Modificar redisConfig para incluir la configuración de compresión
// export const redisConfig: RedisOptions & { compression: CompressionConfig } = {
//   connectTimeout: 5000,
//   commandTimeout: 3000,
//   maxRetriesPerRequest: 3,
//   retryStrategy: (times: number) => {
//     if (times > 3) {
//       return null;
//     }
//     const delay = Math.min(times * 1000, 3000);
//     return delay;
//   },
//   enableReadyCheck: false,
//   lazyConnect: true,
//   compression: compressionConfig
export const redisConfig: RedisOptions & { compression: CompressionConfig } = {
  connectTimeout: 3000,
  commandTimeout: 2000,
  maxRetriesPerRequest: 2,
  retryStrategy: (times: number) => {
    if (times > 2) {
      return null;
    }
    const delay = Math.min(times * 500, 2000);
    return delay;
  },
  enableReadyCheck: false,
  lazyConnect: true,
  compression: compressionConfig
};

