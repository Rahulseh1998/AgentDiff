import {describe, expect, it} from 'vitest';
import {DemoProvider, toAwsInput} from '../src/aws.js';

describe('AWS request translation', () => {
  it('maps normalized ASG fields to AWS SDK casing without forwarding arbitrary input', () => {
    expect(toAwsInput('UpdateAutoScalingGroup', {
      autoScalingGroupName: 'checkout-prod', desiredCapacity: 3, minSize: 2, ignored: 'unsafe',
    })).toEqual({AutoScalingGroupName: 'checkout-prod', DesiredCapacity: 3, MinSize: 2, MaxSize: undefined});
  });

  it('serializes IAM policy documents and validates identifiers', () => {
    expect(toAwsInput('PutRolePolicy', {
      roleName: 'deploy', policyName: 'inline', policyDocument: {Version: '2012-10-17', Statement: []},
    })).toEqual({RoleName: 'deploy', PolicyName: 'inline', PolicyDocument: '{"Version":"2012-10-17","Statement":[]}'});
    expect(() => toAwsInput('PutRolePolicy', {roleName: '', policyName: 'x', policyDocument: {}})).toThrow(/roleName/);
  });

  it('does not pass normalized Lambda keys directly to the SDK', () => {
    expect(toAwsInput('UpdateFunctionConfiguration', {functionName: 'worker', memorySize: 512, timeout: 20}))
      .toEqual({FunctionName: 'worker', MemorySize: 512, Timeout: 20});
  });

  it('maps the public S3 policy field to the SDK Policy field', () => {
    expect(toAwsInput('PutBucketPolicy', {bucket: 'audit-events', policy: {Statement: []}}))
      .toEqual({Bucket: 'audit-events', Policy: '{"Statement":[]}'});
  });
});

describe('demo provider parity', () => {
  it('captures, mutates, and restores normalized ASG state', async () => {
    const provider = new DemoProvider();
    const target = {autoScalingGroupName: 'checkout-prod', desiredCapacity: 3, minSize: 2};
    const before = await provider.before('UpdateAutoScalingGroup', target);
    await provider.execute('UpdateAutoScalingGroup', target);
    expect(await provider.before('UpdateAutoScalingGroup', target)).toMatchObject({desiredCapacity: 3, minSize: 2});
    await provider.execute('UpdateAutoScalingGroup', {
      autoScalingGroupName: 'checkout-prod', desiredCapacity: before.desiredCapacity, minSize: before.minSize,
    });
    expect(await provider.before('UpdateAutoScalingGroup', target)).toMatchObject({desiredCapacity: 12, minSize: 8});
  });

  it('models irreversible deletion honestly', async () => {
    const provider = new DemoProvider();
    await provider.execute('DeleteFunction', {functionName: 'dev-thumbnail'});
    expect(await provider.before('DeleteFunction', {functionName: 'dev-thumbnail'})).toMatchObject({exists: false});
  });
});
