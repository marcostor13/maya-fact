import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as path from 'path';
import { Construct } from 'constructs';
import { fn } from './lambda-defaults.js';

/**
 * Cognito con un trigger de pre-token-generation que inyecta `tenant_id` y
 * `roles` como claims del access token.
 *
 * Por qué importa: a partir de aquí el tenant SIEMPRE sale del token firmado y
 * NUNCA del path, del query string ni del body. Esa sola regla elimina la clase
 * de vulnerabilidad más común de un SaaS multi-tenant (IDOR / OWASP A01).
 */
export class Auth extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly client: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: { prod: boolean }) {
    super(scope, id);

    // Mismo helper que el resto: que "todas las Lambdas tienen tracing y
    // retención de logs acotada" sea verificable exige que no haya excepciones.
    // Esta se había quedado fuera, y era justo la que toca cada login.
    const preToken = fn(this, 'PreTokenGeneration', {
      entry: path.join(__dirname, '../../services/src/auth/pre-token-generation.ts'),
      memorySize: 256,
      // Cognito corta el trigger a los 5 s. Poner más aquí no lo alargaría:
      // solo haría que la función siguiera ejecutándose tras el corte.
      timeout: Duration.seconds(5),
    });

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false, // altas gestionadas: es B2B, no consumo
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      customAttributes: {
        // El tenant vive en el usuario, inmutable una vez asignado.
        tenant_id: new cognito.StringAttribute({ mutable: false, minLen: 1, maxLen: 64 }),
      },
      passwordPolicy: { minLength: 12, requireDigits: true, requireSymbols: true, requireUppercase: true },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: props.prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    /**
     * El trigger se engancha con `addTrigger` y la operación
     * PRE_TOKEN_GENERATION_CONFIG, que es la V2. NO con `lambdaTriggers`.
     *
     * Por qué importa la distinción:
     *  - `PRE_TOKEN_GENERATION` (V1) solo puede modificar el ID token.
     *  - `PRE_TOKEN_GENERATION_CONFIG` (V2) modifica ID token Y ACCESS token.
     * Necesitamos el access token, porque es el que valida el authorizer JWT de
     * API Gateway y del que `callerFrom()` lee el tenant.
     *
     * Y aquí estuvo el fallo más engañoso de todo el repositorio: la versión
     * anterior escribía `lambdaTriggers: { preTokenGenerationV2: preToken }`.
     * Esa clave NO EXISTE en CDK, pero `UserPoolTriggers` declara una index
     * signature `[trigger: string]: IFunction | undefined`, así que TypeScript
     * la aceptó sin rechistar. CDK ignoró la clave desconocida y emitió
     * `LambdaConfig: {}`.
     *
     * Resultado: `tsc` limpio, `cdk synth` limpio, despliegue correcto... y el
     * user pool SIN trigger. El token salía sin `tenant_id`, es decir, el
     * control de aislamiento multi-tenant entero no existía — en silencio.
     * Solo se detecta ejecutándolo y mirando el claim, que es exactamente lo
     * que hace el paso 2 de `smoke.sh`.
     */
    this.userPool.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG, preToken);

    /**
     * Segundo escalón del mismo problema: `addTrigger` genera el bloque
     * PreTokenGenerationConfig, pero CDK lo rellena con `LambdaVersion: V1_0`
     * y no expone ninguna propiedad para cambiarlo. V1_0 solo alcanza al ID
     * token, así que el trigger se invocaría y el claim seguiría sin aparecer
     * en el access token: el mismo síntoma, una causa más profunda.
     *
     * De ahí el escape hatch al recurso L1. Es la clase de detalle que no
     * aparece en ningún tutorial y que solo se descubre desplegando y mirando
     * el token de verdad.
     *
     * Requisito asociado: la personalización del access token exige que el
     * user pool esté en el plan Essentials o Plus. Es el plan por defecto de
     * los pools nuevos, pero si alguien lo baja a Lite, esto deja de funcionar.
     */
    const cfnUserPool = this.userPool.node.defaultChild as cognito.CfnUserPool;
    cfnUserPool.addPropertyOverride('LambdaConfig.PreTokenGenerationConfig.LambdaVersion', 'V2_0');

    this.client = this.userPool.addClient('Web', {
      // userSrp es el único flujo que usa el navegador: la contraseña nunca
      // viaja, ni siquiera cifrada.
      //
      // adminUserPassword se habilita a propósito y NO es una puerta trasera:
      // ADMIN_USER_PASSWORD_AUTH solo se puede invocar con credenciales IAM
      // firmadas contra la API de administración de Cognito, así que no está al
      // alcance de un navegador ni de un atacante sin acceso a la cuenta. Es lo
      // que permite que `smoke.sh` y `probar-aislamiento.sh` obtengan un token
      // sin implementar SRP en bash — es decir, lo que hace que la prueba de
      // aislamiento se pueda ejecutar EN VIVO durante la defensa.
      //
      // En producción se quita: el criterio de revisión está en el ADR-007.
      authFlows: { userSrp: true, adminUserPassword: true },
      accessTokenValidity: Duration.minutes(15),
      idTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true, // no filtrar si un email existe (enumeración)
    });

    new cognito.CfnUserPoolGroup(this, 'GroupAdmin', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'tenant-admin',
    });
    new cognito.CfnUserPoolGroup(this, 'GroupReviewer', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'reviewer',
    });
  }
}
