import { Response } from 'express';
import { EventEmitter } from 'events';
import mongoosePackage from 'mongoose';
import { Task, ITask, TaskType, TaskStatus } from './task.model';
import { AppError } from '../../middleware/errorHandler';

const taskEventEmitter = new EventEmitter();

export interface TaskProgressPayload {
  taskId: string;
  jobId: string;
  type: TaskType;
  status: TaskStatus;
  phase: string;
  progress: number;
  processedCount: number;
  totalCount: number;
  error?: string;
  resultSummary?: Record<string, any>;
}

export class TaskService {
  /**
   * Create a new tracked task in the database
   */
  public static async createTask(
    jobId: string,
    type: TaskType,
    totalCount = 0
  ): Promise<ITask> {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const task = new Task({
      taskId,
      jobId: new mongoosePackage.Types.ObjectId(jobId),
      type,
      status: 'pending',
      phase: 'initializing',
      progress: 0,
      processedCount: 0,
      totalCount,
    });

    const saved = await task.save();
    this.broadcast(taskId, {
      taskId,
      jobId,
      type,
      status: 'pending',
      phase: 'initializing',
      progress: 0,
      processedCount: 0,
      totalCount,
    });

    return saved;
  }

  /**
   * Update task progress and broadcast via SSE
   */
  public static async updateProgress(
    taskId: string,
    updates: {
      phase: string;
      progress?: number;
      processedCount?: number;
      totalCount?: number;
    }
  ): Promise<ITask | null> {
    const task = await Task.findOne({ taskId }).exec();
    if (!task) return null;

    task.status = 'running';
    task.phase = updates.phase;
    if (updates.processedCount !== undefined) task.processedCount = updates.processedCount;
    if (updates.totalCount !== undefined) task.totalCount = updates.totalCount;

    if (updates.progress !== undefined) {
      task.progress = Math.min(100, Math.max(0, updates.progress));
    } else if (task.totalCount > 0) {
      task.progress = Math.min(100, Math.round((task.processedCount / task.totalCount) * 100));
    }

    const saved = await task.save();

    this.broadcast(taskId, {
      taskId,
      jobId: saved.jobId.toString(),
      type: saved.type,
      status: saved.status,
      phase: saved.phase,
      progress: saved.progress,
      processedCount: saved.processedCount,
      totalCount: saved.totalCount,
    });

    return saved;
  }

  /**
   * Mark task as completed
   */
  public static async completeTask(
    taskId: string,
    resultSummary?: Record<string, any>
  ): Promise<ITask | null> {
    const task = await Task.findOne({ taskId }).exec();
    if (!task) return null;

    task.status = 'completed';
    task.phase = 'completed';
    task.progress = 100;
    if (resultSummary) task.resultSummary = resultSummary;

    const saved = await task.save();

    this.broadcast(taskId, {
      taskId,
      jobId: saved.jobId.toString(),
      type: saved.type,
      status: 'completed',
      phase: 'completed',
      progress: 100,
      processedCount: saved.processedCount,
      totalCount: saved.totalCount,
      resultSummary,
    });

    return saved;
  }

  /**
   * Mark task as failed
   */
  public static async failTask(taskId: string, errorMessage: string): Promise<ITask | null> {
    const task = await Task.findOne({ taskId }).exec();
    if (!task) return null;

    task.status = 'failed';
    task.phase = 'failed';
    task.error = errorMessage;

    const saved = await task.save();

    this.broadcast(taskId, {
      taskId,
      jobId: saved.jobId.toString(),
      type: saved.type,
      status: 'failed',
      phase: 'failed',
      progress: saved.progress,
      processedCount: saved.processedCount,
      totalCount: saved.totalCount,
      error: errorMessage,
    });

    return saved;
  }

  public static async getByTaskId(taskId: string): Promise<ITask> {
    const task = await Task.findOne({ taskId }).exec();
    if (!task) {
      throw new AppError(`Task with ID ${taskId} not found`, 404, 'TASK_NOT_FOUND');
    }
    return task;
  }

  public static async getLatestActiveTask(jobId: string): Promise<ITask | null> {
    return Task.findOne({
      jobId: new mongoosePackage.Types.ObjectId(jobId),
      status: { $in: ['pending', 'running'] },
    })
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * Subscribe an Express Response to Server-Sent Events
   */
  public static subscribeSSE(taskId: string, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Send initial ping
    res.write(`event: connected\ndata: ${JSON.stringify({ taskId, timestamp: new Date() })}\n\n`);

    // Stream current persisted state immediately
    this.getByTaskId(taskId)
      .then((task) => {
        res.write(`event: task.progress\ndata: ${JSON.stringify(task)}\n\n`);
      })
      .catch(() => {});

    // Listener for live updates
    const listener = (payload: TaskProgressPayload) => {
      if (payload.status === 'completed') {
        res.write(`event: task.completed\ndata: ${JSON.stringify(payload)}\n\n`);
      } else if (payload.status === 'failed') {
        res.write(`event: task.failed\ndata: ${JSON.stringify(payload)}\n\n`);
      } else {
        res.write(`event: task.progress\ndata: ${JSON.stringify(payload)}\n\n`);
      }
    };

    taskEventEmitter.on(`task:${taskId}`, listener);

    res.on('close', () => {
      taskEventEmitter.off(`task:${taskId}`, listener);
    });
  }

  private static broadcast(taskId: string, payload: TaskProgressPayload): void {
    taskEventEmitter.emit(`task:${taskId}`, payload);
  }
}

