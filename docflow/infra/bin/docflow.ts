#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { DocFlowStack } from '../lib/docflow-stack.js';
import { CicdStack } from '../lib/cicd.js';

const app = new App();

// El model id COMPLETO con versión, nunca un alias. AWS documenta un ciclo de
// vida (Active / Legacy / EOL) con al menos 12 meses de vida y 6 meses en
// Legacy antes del fin: eso da margen, pero migrar sin conjunto dorado es
// saltar sin red.
const modelId = app.node.tryGetContext('modelId') ?? process.env.MODEL_ID ?? 'us.amazon.nova-lite-v1:0';

/**
 * La región es una DECISIÓN DE ARQUITECTURA, no una preferencia del entorno.
 *
 * Deliberadamente NO se lee de CDK_DEFAULT_REGION. El CLI de CDK sobrescribe esa
 * variable con la región del perfil de AWS resuelto, ignorando lo que exportes
 * en el shell. Si el diseño dependiera de ella, un `aws configure` con otra
 * región desplegaría en un sitio distinto sin decir nada — y ahí dentro no
 * existe el Web ACL de CloudFront (solo vive en us-east-1) ni está garantizada
 * la disponibilidad del modelo de Bedrock. El stack subiría "bien" y sin WAF.
 *
 * Para cambiarla, se cambia a propósito: `cdk deploy -c region=eu-west-1`.
 */
const region: string = app.node.tryGetContext('region') ?? process.env.DOCFLOW_REGION ?? 'us-east-1';

/**
 * El stack de CI/CD es INDEPENDIENTE y se despliega a mano una sola vez.
 *
 * No puede formar parte del stack de la aplicación por una razón de orden: crea
 * el rol que el pipeline usa para desplegar la aplicación. Si viviera dentro,
 * el pipeline necesitaría el rol para crear el rol.
 */
new CicdStack(app, 'DocFlow-Cicd', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  repo: app.node.tryGetContext('repo') ?? 'marcostor13/maya-fact',
  ramas: ['main'],
});

new DocFlowStack(app, 'DocFlow-Dev', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  prod: false,
  modelId,
  alarmEmail: process.env.ALARM_EMAIL,
  monthlyBudgetUsd: 50,
});
