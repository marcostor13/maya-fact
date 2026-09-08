import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import { Construct } from 'constructs';

export interface ObservabilityProps {
  queue: sqs.Queue;
  dlq: sqs.Queue;
  stateMachine: sfn.StateMachine;
  alarmEmail?: string;
  monthlyBudgetUsd: number;
}

/**
 * Alarmas sobre SÍNTOMAS que el usuario nota, no sobre causas internas.
 */
export class Observability extends Construct {
  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);

    const topic = new sns.Topic(this, 'Alarms', { displayName: 'DocFlow alarmas' });
    const action = new actions.SnsAction(topic);

    // La alarma más importante del sistema. Un solo mensaje en la DLQ significa
    // que un documento de un cliente se quedó sin procesar. Umbral 0, no 10.
    new cloudwatch.Alarm(this, 'DlqNotEmpty', {
      alarmDescription: 'P1 — hay documentos sin procesar en la DLQ',
      metric: props.dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), statistic: 'Maximum' }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(action);

    // El SLO es "resultado en menos de 5 minutos". Si el mensaje más viejo
    // lleva 5 minutos esperando, el SLO ya está en riesgo: avisa ANTES de
    // incumplirlo, no después.
    new cloudwatch.Alarm(this, 'BacklogAging', {
      alarmDescription: 'El pipeline se está atrasando frente al SLO de 5 minutos',
      metric: props.queue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(1), statistic: 'Maximum' }),
      threshold: 300,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    }).addAlarmAction(action);

    // Los fallos permanentes NO hacen fallar una ejecución: se cierran como
    // QUARANTINED a propósito. Por eso esta alarma significa algo muy concreto y
    // muy grave: se rompió algo que el pipeline no supo clasificar — un bug
    // nuestro, no un documento malo. Sin ella, ese caso es invisible: no llega a
    // la DLQ (el mensaje se consumió) y no aparece en el backlog.
    new cloudwatch.Alarm(this, 'EjecucionesFallidas', {
      alarmDescription: 'Ejecuciones de Step Functions fallidas: fallo no clasificado',
      metric: props.stateMachine.metricFailed({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(action);

    // En un sistema cuyo coste dominante es por unidad procesada, el GASTO es
    // una señal de salud: un pico de coste es un pico de abuso o un bug.
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'docflow-mensual',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.monthlyBudgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: props.alarmEmail
        ? [
            {
              notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' },
              subscribers: [{ subscriptionType: 'EMAIL', address: props.alarmEmail }],
            },
          ]
        : [],
    });

    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'DocFlow',
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'Decisiones por estado',
            // DUPLICATE y QUARANTINED están aquí a propósito: son los dos
            // estados que NO son un resultado de negocio. Si DUPLICATE sube, el
            // cliente está reenviando (y tú ahorrando); si QUARANTINED sube,
            // algo cambió en lo que te mandan. Verlos junto a los otros tres es
            // lo que convierte el panel en un diagnóstico y no en un marcador.
            left: ['APPROVED', 'NEEDS_REVIEW', 'REJECTED', 'DUPLICATE', 'QUARANTINED'].map(
              (s) => new cloudwatch.Metric({ namespace: 'DocFlow', metricName: `Decision_${s}`, statistic: 'Sum' }),
            ),
          }),
          new cloudwatch.GraphWidget({
            title: 'Tokens consumidos (proxy de coste)',
            left: [
              new cloudwatch.Metric({ namespace: 'DocFlow', metricName: 'InputTokens', statistic: 'Sum' }),
              new cloudwatch.Metric({ namespace: 'DocFlow', metricName: 'OutputTokens', statistic: 'Sum' }),
            ],
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Cola',
            left: [props.queue.metricApproximateAgeOfOldestMessage(), props.queue.metricApproximateNumberOfMessagesVisible()],
            right: [props.dlq.metricApproximateNumberOfMessagesVisible()],
          }),
          new cloudwatch.GraphWidget({
            title: 'Duplicados suprimidos (ahorro por idempotencia)',
            left: [new cloudwatch.Metric({ namespace: 'DocFlow', metricName: 'DuplicateSuppressed', statistic: 'Sum' })],
          }),
        ],
      ],
    });
  }
}
