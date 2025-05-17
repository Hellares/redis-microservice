// Crear un nuevo archivo src/constants/redis-entities.constants.ts

/**
 * Constantes para definir los tipos de entidades utilizadas en las claves de Redis
 * Esto facilita la limpieza de caché por entidad específica
 */
export const REDIS_ENTITIES = {
  // Ejemplos basados en tu estructura "SERVICIO123:SERV456:all:page2:limit10"
  SERVICIO: 'SERVICIO',
  SERV: 'SERV',
  // Añade aquí más tipos de entidades según necesites
};

/**
 * Funciones de ayuda para generar patrones de limpieza de caché
 */
export const REDIS_PATTERNS = {
  /**
   * Genera un patrón para limpiar todas las claves relacionadas con un servicio específico
   * @param servicioId Identificador del servicio
   */
  forServicio: (servicioId: string) => `${REDIS_ENTITIES.SERVICIO}${servicioId}:*`,

  /**
   * Genera un patrón para limpiar todas las claves relacionadas con un SERV específico
   * @param servId Identificador del SERV
   */
  forServ: (servId: string) => `*:${REDIS_ENTITIES.SERV}${servId}:*`,

  /**
   * Genera un patrón para limpiar todas las claves relacionadas con un servicio y un SERV específicos
   * @param servicioId Identificador del servicio
   * @param servId Identificador del SERV
   */
  forServicioAndServ: (servicioId: string, servId: string) => 
    `${REDIS_ENTITIES.SERVICIO}${servicioId}:${REDIS_ENTITIES.SERV}${servId}:*`,

  /**
   * Genera un patrón para limpiar todas las claves que coincidan con los segmentos proporcionados
   * @param segments Segmentos que componen la clave
   */
  forSegments: (segments: string[]) => segments.join(':') + ':*',
};