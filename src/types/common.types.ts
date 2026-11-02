export type ID = string;

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PageRequest {
  page: number;
  pageSize: number;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  message?: string;
  requestId: string;
}

export interface ApiFailure {
  success: false;
  error: { code: string; message: string; details?: unknown };
  requestId: string;
}
