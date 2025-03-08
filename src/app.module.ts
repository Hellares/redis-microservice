import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { CacheModule } from './module/cache-module';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
  
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        messageKey: 'message',
        autoLogging: false,
        
        transport: process.env.NODE_ENV !== 'production' 
          ? {
              target: 'pino-pretty',
              options: {
                messageKey: 'message',
                colorize: true,
                ignore: 'pid,hostname',
                translateTime: 'SYS:standard',
              },
            }
          : undefined, // En producción, usar JSON directo a stdout
        
        // Metadatos que se añadirán a todos los logs
        customProps: () => ({
          service: 'redis-microservice',
          environment: process.env.NODE_ENV || 'development',
          version: process.env.APP_VERSION || '1.0.0',
        }),
        
        // Redactado de información sensible
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
          remove: true,
        },
        
        // Formato de serialización optimizado para producción
        serializers: {
          req: (req) => ({
            id: req.id,
            method: req.method,
            url: req.url,
          }),
          res: (res) => ({
            statusCode: res.statusCode,
          }),
          err: (err) => ({
            type: err.constructor.name,
            message: err.message,
            stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
          }),
        },
      },
    }),
    CacheModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}