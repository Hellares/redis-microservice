// src/constants/redis-cache.keys.contants.ts (en tu microservicio)

export const CACHE_KEYS = {
  RUBRO: {
    // Keys base que pueden ser usadas directamente
    BASE: {
      ACTIVE: 'rubroactive',
      DELETED: 'rubrodeleted',
    },
    // Métodos para generar keys específicas
    PAGINATED: (page: number, limit: number) => 
      `rubroactive:all:page${page}:limit${limit}`,
    SINGLE: (id: string) => 
      `rubro:${id}`,
    ALL_ACTIVE: 'rubroactive:all',
    ALL_DELETED: 'rubrodeleted:all',
    // Patrón para invalidación
    PATTERN: 'rubro:*'
  },
  
  PLAN: {
    BASE: {
      ACTIVE: 'planactive',
      DELETED: 'plandeleted',
    },
    PAGINATED: (page: number, limit: number) => 
      `planactive:all:page${page}:limit${limit}`,
    SINGLE: (id: string) => 
      `plan:${id}`,
    ALL_ACTIVE: 'planactive:all',
    ALL_DELETED: 'plandeleted:all',
    PATTERN: 'plan:*'
  },

  ARCHIVO: {
    BASE: {
      ACTIVE: 'archivoactive',
      DELETED: 'archivodeleted',
    },
    PAGINATED: (page: number, limit: number) => 
      `archivoactive:all:page${page}:limit${limit}`,
    PAGINATED_BY_EMPRESA: (empresaId: string, page: number, limit: number, categoria?: string) => 
      `archivoactive:empresa:${empresaId}:${categoria || 'all'}:page${page}:limit${limit}`,
    PAGINATED_BY_ENTIDAD: (tipoEntidad: string, entidadId: string, page: number, limit: number, categoria?: string) => 
      `archivoactive:entidad:${tipoEntidad}:${entidadId}:${categoria || 'all'}:page${page}:limit${limit}`,
    SINGLE: (id: string) => 
      `archivo:${id}`,
    ALL_ACTIVE: 'archivoactive:all',
    ALL_DELETED: 'archivodeleted:all',
    PATTERN: 'archivo:*',
    PATTERN_ACTIVE: 'archivoactive:*',
    PATTERN_SINGLE: 'archivo:*',
    EMPRESA_PATTERN: (empresaId: string) => `archivoactive:empresa:${empresaId}:*`,
    ENTIDAD_PATTERN: (tipoEntidad: string, entidadId: string) => 
    `archivoactive:entidad:${tipoEntidad}:${entidadId}:*`
  },
};