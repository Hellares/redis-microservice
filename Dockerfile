# Etapa de construcción
FROM node:18-alpine AS build

# Establecer directorio de trabajo
WORKDIR /app

# Copiar package.json y package-lock.json
COPY package*.json ./

# Instalar dependencias incluyendo las de desarrollo (necesarias para compilar)
RUN npm ci || npm install

# Copiar el código fuente
COPY . .

# Compilar la aplicación
RUN npm run build

# Etapa de producción
FROM node:18-alpine AS production

# Definir variables de entorno predeterminadas que pueden ser sobrescritas
ENV NODE_ENV=production
ENV PORT=3003
ENV REDIS_URL=redis://default:jtorres@elastika-redis:6379
ENV RABBITMQ_SERVERS=amqp://admin:admin123@rabbitmq-server:5672
ENV CIRCUIT_BREAKER_THRESHOLD=2
ENV CIRCUIT_BREAKER_TIMEOUT=30000

# Establecer directorio de trabajo
WORKDIR /app

# Copiar package.json y package-lock.json
COPY package*.json ./

# Instalar solo dependencias de producción
RUN npm ci --only=production || npm install --only=production

# Copiar los archivos compilados desde la etapa de build
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules

# Exponer el puerto 3003 (según tu configuración)
EXPOSE 3003

# Comando para ejecutar la aplicación
CMD ["node", "dist/main"]