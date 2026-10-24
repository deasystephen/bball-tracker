/**
 * Config-bound test over the web app's deploy file (#30).
 *
 * `infra/web-task-definition.json` is the single source of truth for the web
 * service's runtime, as `infra/task-definition.json` is for the API. CI
 * registers it into the family `infra/web.tf` names and replaces the two
 * placeholders. These pin what the site needs to work and what it must never
 * carry: it holds no secret and needs no AWS permission.
 */
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const WEB_TASK_DEFINITION = readFileSync(path.join(ROOT, 'infra/web-task-definition.json'), 'utf8');
const WEB_TF = readFileSync(path.join(ROOT, 'infra/web.tf'), 'utf8');
const CI_WORKFLOW = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

interface WebTaskDefinition {
  family: string;
  taskRoleArn?: string;
  containerDefinitions: Array<{
    name: string;
    image: string;
    portMappings: Array<{ containerPort: number }>;
    environment?: Array<{ name: string; value: string }>;
    secrets?: unknown[];
    logConfiguration: { options: Record<string, string> };
  }>;
}

const taskDefinition = JSON.parse(WEB_TASK_DEFINITION) as WebTaskDefinition;
const [container] = taskDefinition.containerDefinitions;
const env = new Map((container.environment ?? []).map((e) => [e.name, e.value]));

describe('infra/web-task-definition.json (#30)', () => {
  it('has one container, named as the service and the CI render step expect', () => {
    expect(taskDefinition.containerDefinitions).toHaveLength(1);
    expect(container.name).toBe('web');
    expect(WEB_TF).toMatch(/container_name\s+=\s+"web"/);
    expect(CI_WORKFLOW).toMatch(/task-definition: infra\/web-task-definition\.json\n\s+container-name: web\n/);
  });

  it('registers into the family web.tf points the service at', () => {
    expect(taskDefinition.family).toBe('bball-tracker-production-web');
    expect(WEB_TF).toContain('web_family     = "${local.name_prefix}-web"');
  });

  it('listens on the port the target group and security group use', () => {
    expect(container.portMappings.map((p) => p.containerPort)).toEqual([3000]);
    expect(env.get('PORT')).toBe('3000');
    expect(env.get('HOSTNAME')).toBe('0.0.0.0');
    expect(WEB_TF).toContain('web_port       = 3000');
  });

  it('keeps idle connections open longer than the ALB (60 s), as the API does (#749)', () => {
    // Below the ALB's idle timeout, the server closes a connection the ALB is
    // about to reuse, and the request becomes an ELB 502 the app never sees.
    expect(Number(env.get('KEEP_ALIVE_TIMEOUT'))).toBeGreaterThan(60_000);
  });

  it('looks invitations up on the production API', () => {
    expect(env.get('API_URL')).toBe('https://api.hooplings.com');
    expect(CI_WORKFLOW).toContain('--build-arg NEXT_PUBLIC_API_URL=https://api.hooplings.com web');
  });

  it('carries the placeholders the deploy job replaces', () => {
    expect(container.image).toBe('IMAGE_PLACEHOLDER');
    expect(env.get('GIT_COMMIT')).toBe('GIT_COMMIT_PLACEHOLDER');
    expect(CI_WORKFLOW).toContain('sed -i "s/GIT_COMMIT_PLACEHOLDER/${{ github.sha }}/g" infra/web-task-definition.json');
  });

  it('holds no secret and takes no task role', () => {
    expect(container.secrets ?? []).toEqual([]);
    expect(taskDefinition.taskRoleArn).toBeUndefined();
  });

  it('logs to its own group, which web.tf creates and Datadog does not forward', () => {
    expect(container.logConfiguration.options['awslogs-group']).toBe('/ecs/bball-tracker-production-web');
    expect(WEB_TF).toContain('name              = "/ecs/${local.web_family}"');
  });
});
