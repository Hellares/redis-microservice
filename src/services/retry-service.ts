// import { Injectable, Logger } from '@nestjs/common';

// interface RetryOptions {
//   maxAttempts: number;
//   backoff: number;
// }

// @Injectable()
// export class RetryService {
//   private readonly logger = new Logger(RetryService.name);

//   async execute<T>(
//     operation: () => Promise<T>,
//     options: RetryOptions
//   ): Promise<T> {
//     let lastError: Error;
    
//     for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
//       try {
//         return await operation();
//       } catch (error) {
//         lastError = error;
        
//         if (attempt === options.maxAttempts) {
//           this.logger.error(`❌ Todos los reintentos fallaron después de ${attempt} intentos`);
//           throw error;
//         }

//         this.logger.warn(`⚠️ Intento ${attempt} fallido, reintentando en ${options.backoff}ms...`);
//         await this.delay(options.backoff * attempt); // Backoff exponencial
//       }
//     }

//     throw lastError;
//   }

//   private delay(ms: number): Promise<void> {
//     return new Promise(resolve => setTimeout(resolve, ms));
//   }
// }