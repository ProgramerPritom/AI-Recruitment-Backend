import mongoose, { Schema, Document } from 'mongoose';

export type TaskType = 'sourcing' | 'scoring' | 'outreach';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ITask extends Document {
  taskId: string;
  jobId: mongoose.Types.ObjectId;
  type: TaskType;
  status: TaskStatus;
  phase: string;
  progress: number;
  processedCount: number;
  totalCount: number;
  error?: string;
  resultSummary?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const TaskSchema = new Schema<ITask>(
  {
    taskId: { type: String, required: true, unique: true, index: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    type: {
      type: String,
      enum: ['sourcing', 'scoring', 'outreach'],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed'],
      default: 'pending',
      index: true,
    },
    phase: { type: String, default: 'initializing' },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    processedCount: { type: Number, default: 0 },
    totalCount: { type: Number, default: 0 },
    error: { type: String },
    resultSummary: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
  }
);

export const Task = mongoose.model<ITask>('Task', TaskSchema);

