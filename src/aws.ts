import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  UpdateAutoScalingGroupCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  DescribeInstancesCommand,
  EC2Client,
  StopInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import {DescribeServicesCommand, ECSClient, UpdateServiceCommand} from '@aws-sdk/client-ecs';
import {
  DeleteFunctionCommand,
  GetFunctionConfigurationCommand,
  LambdaClient,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import {
  AttachRolePolicyCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';
import {DeleteBucketCommand, GetBucketPolicyCommand, HeadBucketCommand, PutBucketPolicyCommand, S3Client} from '@aws-sdk/client-s3';
import {fromTemporaryCredentials} from '@aws-sdk/credential-providers';
import type {Operation} from './types.js';

export type ProviderState = Record<string, unknown>;
export interface Provider {
  before(operation: Operation, params: ProviderState): Promise<ProviderState>;
  execute(operation: Operation, params: ProviderState): Promise<{requestId?: string}>;
}

const requiredString = (params: ProviderState, key: string): string => {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`);
  return value;
};

const optionalNumber = (params: ProviderState, key: string): number | undefined => {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
};

const stringArray = (params: ProviderState, key: string): string[] => {
  const value = params[key];
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item)) {
    throw new Error(`${key} must be a non-empty array of strings`);
  }
  return value;
};

const policyDocument = (value: unknown): string => {
  if (typeof value === 'string') {
    JSON.parse(value); // reject malformed documents before sending them to AWS
    return value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('policyDocument must be a JSON object');
  return JSON.stringify(value);
};

/** Translate the gateway's stable camelCase contract to exact AWS SDK inputs. */
export function toAwsInput(operation: Operation, p: ProviderState): ProviderState {
  switch (operation) {
    case 'UpdateAutoScalingGroup': return {
      AutoScalingGroupName: requiredString(p, 'autoScalingGroupName'),
      MinSize: optionalNumber(p, 'minSize'), MaxSize: optionalNumber(p, 'maxSize'),
      DesiredCapacity: optionalNumber(p, 'desiredCapacity'),
    };
    case 'StopInstances':
    case 'TerminateInstances': return {InstanceIds: stringArray(p, 'instanceIds')};
    case 'UpdateService': return {
      cluster: requiredString(p, 'cluster'), service: requiredString(p, 'service'),
      desiredCount: optionalNumber(p, 'desiredCount'),
      ...(p.taskDefinition === undefined ? {} : {taskDefinition: requiredString(p, 'taskDefinition')}),
      ...(p.forceNewDeployment === undefined ? {} : {forceNewDeployment: p.forceNewDeployment === true}),
    };
    case 'UpdateFunctionConfiguration': return {
      FunctionName: requiredString(p, 'functionName'),
      ...(p.memorySize === undefined ? {} : {MemorySize: optionalNumber(p, 'memorySize')}),
      ...(p.timeout === undefined ? {} : {Timeout: optionalNumber(p, 'timeout')}),
      ...(p.description === undefined ? {} : {Description: requiredString(p, 'description')}),
      ...(p.runtime === undefined ? {} : {Runtime: requiredString(p, 'runtime')}),
      ...(p.environment === undefined ? {} : {Environment: p.environment}),
    };
    case 'DeleteFunction': return {FunctionName: requiredString(p, 'functionName')};
    case 'PutRolePolicy': return {
      RoleName: requiredString(p, 'roleName'), PolicyName: requiredString(p, 'policyName'),
      PolicyDocument: policyDocument(p.policyDocument),
    };
    case 'AttachRolePolicy': return {RoleName: requiredString(p, 'roleName'), PolicyArn: requiredString(p, 'policyArn')};
    case 'UpdateAssumeRolePolicy': return {
      RoleName: requiredString(p, 'roleName'), PolicyDocument: policyDocument(p.policyDocument),
    };
    case 'PutBucketPolicy': return {Bucket: requiredString(p, 'bucket'), Policy: policyDocument(p.policy)};
    case 'DeleteBucket': return {Bucket: requiredString(p, 'bucket')};
  }
}

const config = () => ({
  region: process.env.AWS_REGION || 'us-east-1',
  ...(process.env.AWS_ROLE_ARN ? {credentials: fromTemporaryCredentials({
    params: {RoleArn: process.env.AWS_ROLE_ARN, RoleSessionName: 'agent-transaction'},
    clientConfig: {region: process.env.AWS_REGION || 'us-east-1'},
  })} : {}),
});

const decodeIamDocument = (value: string | undefined): unknown => {
  if (!value) return undefined;
  try { return JSON.parse(decodeURIComponent(value)); } catch { return value; }
};

export class AwsProvider implements Provider {
  async before(operation: Operation, p: ProviderState): Promise<ProviderState> {
    switch (operation) {
      case 'UpdateAutoScalingGroup': {
        const name = requiredString(p, 'autoScalingGroupName');
        const group = (await new AutoScalingClient(config()).send(new DescribeAutoScalingGroupsCommand({AutoScalingGroupNames: [name]}))).AutoScalingGroups?.[0];
        if (!group) throw new Error(`Auto Scaling group ${name} not found`);
        return {autoScalingGroupName: name, minSize: group.MinSize, maxSize: group.MaxSize,
          desiredCapacity: group.DesiredCapacity, instances: group.Instances?.map(i => i.InstanceId).filter(Boolean),
          targetGroupARNs: group.TargetGroupARNs ?? [], exists: true};
      }
      case 'UpdateFunctionConfiguration':
      case 'DeleteFunction': {
        const functionName = requiredString(p, 'functionName');
        const fn = await new LambdaClient(config()).send(new GetFunctionConfigurationCommand({FunctionName: functionName}));
        return {functionName, runtime: fn.Runtime, memorySize: fn.MemorySize, timeout: fn.Timeout,
          description: fn.Description, environment: {Variables: fn.Environment?.Variables ?? {}}, exists: true};
      }
      case 'UpdateService': {
        const cluster = requiredString(p, 'cluster'), service = requiredString(p, 'service');
        const response = await new ECSClient(config()).send(new DescribeServicesCommand({cluster, services: [service]}));
        const item = response.services?.[0];
        if (!item || response.failures?.length) throw new Error(`ECS service ${service} not found in ${cluster}`);
        return {cluster, service, desiredCount: item.desiredCount, taskDefinition: item.taskDefinition,
          runningCount: item.runningCount, pendingCount: item.pendingCount, status: item.status, exists: true};
      }
      case 'StopInstances':
      case 'TerminateInstances': {
        const instanceIds = stringArray(p, 'instanceIds');
        const result = await new EC2Client(config()).send(new DescribeInstancesCommand({InstanceIds: instanceIds}));
        const instances = result.Reservations?.flatMap(r => r.Instances ?? []).map(i => ({id: i.InstanceId, state: i.State?.Name})) ?? [];
        if (instances.length !== instanceIds.length) throw new Error('One or more EC2 instances were not found');
        return {instanceIds, instances, states: Object.fromEntries(instances.map(i => [i.id, i.state])), exists: true};
      }
      case 'PutRolePolicy': {
        const roleName = requiredString(p, 'roleName'), policyName = requiredString(p, 'policyName');
        try {
          const result = await new IAMClient(config()).send(new GetRolePolicyCommand({RoleName: roleName, PolicyName: policyName}));
          return {roleName, policyName, policyDocument: decodeIamDocument(result.PolicyDocument), policyExists: true, exists: true};
        } catch (error) {
          if ((error as {name?: string}).name !== 'NoSuchEntityException') throw error;
          return {roleName, policyName, policyExists: false, exists: true};
        }
      }
      case 'AttachRolePolicy': {
        const roleName = requiredString(p, 'roleName');
        const attached = await new IAMClient(config()).send(new ListAttachedRolePoliciesCommand({RoleName: roleName}));
        return {roleName, attachedPolicyArns: attached.AttachedPolicies?.map(x => x.PolicyArn).filter(Boolean) ?? [], exists: true};
      }
      case 'UpdateAssumeRolePolicy': {
        const roleName = requiredString(p, 'roleName');
        const role = (await new IAMClient(config()).send(new GetRoleCommand({RoleName: roleName}))).Role;
        if (!role) throw new Error(`IAM role ${roleName} not found`);
        return {roleName, policyDocument: decodeIamDocument(role.AssumeRolePolicyDocument), exists: true};
      }
      case 'PutBucketPolicy':
      case 'DeleteBucket': {
        const bucket = requiredString(p, 'bucket');
        await new S3Client(config()).send(new HeadBucketCommand({Bucket: bucket}));
        try {
          const policy = await new S3Client(config()).send(new GetBucketPolicyCommand({Bucket: bucket}));
          return {bucket, policy: policy.Policy ? JSON.parse(policy.Policy) : undefined, policyExists: Boolean(policy.Policy), exists: true};
        } catch (error) {
          if ((error as {name?: string}).name !== 'NoSuchBucketPolicy') throw error;
          return {bucket, policyExists: false, exists: true};
        }
      }
    }
  }

  async execute(operation: Operation, p: ProviderState): Promise<{requestId?: string}> {
    const input = toAwsInput(operation, p);
    let response: {$metadata: {requestId?: string}};
    switch (operation) {
      case 'UpdateAutoScalingGroup': response = await new AutoScalingClient(config()).send(new UpdateAutoScalingGroupCommand(input as never)); break;
      case 'StopInstances': response = await new EC2Client(config()).send(new StopInstancesCommand(input as never)); break;
      case 'TerminateInstances': response = await new EC2Client(config()).send(new TerminateInstancesCommand(input as never)); break;
      case 'UpdateService': response = await new ECSClient(config()).send(new UpdateServiceCommand(input as never)); break;
      case 'UpdateFunctionConfiguration': response = await new LambdaClient(config()).send(new UpdateFunctionConfigurationCommand(input as never)); break;
      case 'DeleteFunction': response = await new LambdaClient(config()).send(new DeleteFunctionCommand(input as never)); break;
      case 'PutRolePolicy': response = await new IAMClient(config()).send(new PutRolePolicyCommand(input as never)); break;
      case 'AttachRolePolicy': response = await new IAMClient(config()).send(new AttachRolePolicyCommand(input as never)); break;
      case 'UpdateAssumeRolePolicy': response = await new IAMClient(config()).send(new UpdateAssumeRolePolicyCommand(input as never)); break;
      case 'PutBucketPolicy': response = await new S3Client(config()).send(new PutBucketPolicyCommand(input as never)); break;
      case 'DeleteBucket': response = await new S3Client(config()).send(new DeleteBucketCommand(input as never)); break;
    }
    return {requestId: response.$metadata.requestId};
  }
}

const resourceKey = (p: ProviderState) => String(p.autoScalingGroupName ?? p.functionName ?? p.roleName ?? p.bucket ?? p.service ?? (p.instanceIds as string[] | undefined)?.join(',') ?? 'resource');

/** Stateful provider used only when DEMO_MODE=true. It follows the same normalized state contract as AWS. */
export class DemoProvider implements Provider {
  readonly state = new Map<string, ProviderState>([
    ['checkout-prod', {autoScalingGroupName: 'checkout-prod', desiredCapacity: 12, minSize: 8, maxSize: 20,
      instances: ['i-demo1', 'i-demo2'], targetGroupARNs: ['checkout-api', 'order-service'], exists: true}],
    ['dev-thumbnail', {functionName: 'dev-thumbnail', memorySize: 256, timeout: 15, runtime: 'nodejs20.x', exists: true}],
  ]);

  async before(_operation: Operation, params: ProviderState): Promise<ProviderState> {
    return structuredClone(this.state.get(resourceKey(params)) ?? {...params, exists: true});
  }

  async execute(operation: Operation, params: ProviderState): Promise<{requestId: string}> {
    // Validate exactly as production does, so demo mode cannot conceal malformed requests.
    toAwsInput(operation, params);
    const key = resourceKey(params);
    if (['DeleteFunction', 'TerminateInstances', 'DeleteBucket'].includes(operation)) {
      this.state.set(key, {...(this.state.get(key) ?? {}), exists: false});
    } else if (operation === 'StopInstances') {
      const ids = stringArray(params, 'instanceIds');
      this.state.set(key, {...(this.state.get(key) ?? {}), instanceIds: ids,
        states: Object.fromEntries(ids.map(id => [id, 'stopped']))});
    } else {
      this.state.set(key, {...(this.state.get(key) ?? {}), ...params, exists: true});
    }
    return {requestId: `demo-${Date.now()}`};
  }
}
