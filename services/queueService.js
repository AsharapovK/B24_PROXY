/**
 * Сервис очереди запросов на основе p-queue.
 * Экспортирует requestQueue для управления асинхронными задачами с ограничением по concurrency.
 */
import PQueue from "p-queue";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { MAX_CONCURRENCY } = require("../config/proxy-config.cjs");

const queue = new PQueue({ concurrency: MAX_CONCURRENCY });

export const requestQueue = queue; 