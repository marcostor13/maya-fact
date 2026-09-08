import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface CicdStackProps extends StackProps {
  /** `usuario/repositorio` en GitHub. */
  repo: string;
  /**
   * La MISMA identidad, con los identificadores numéricos: `usuario@<id>/repo@<id>`.
   *
   * GitHub emite el claim `sub` en dos formatos, y cuál te toca no lo eliges tú:
   *
   *   repo:marcostor13/maya-fact:environment:produccion                 (clásico)
   *   repo:marcostor13@29555756/maya-fact@1361588720:environment:produccion  (inmutable)
   *
   * El segundo existe por una buena razón de seguridad: si renombras el
   * repositorio o cambias de usuario, el nombre queda libre y otra persona
   * podría registrarlo. Con el nombre a secas, esa persona heredaría tu
   * confianza en IAM. Con los ids numéricos —que no se reciclan— no.
   *
   * Se declaran AMBOS formatos porque el despliegue no puede depender de en qué
   * fase del despliegue de esa funcionalidad esté GitHub ese día.
   *
   * Y no vale resolverlo poniendo un comodín tras el nombre del propietario:
   * `marcostor13` seguido de comodín casaría también con un usuario llamado
   * `marcostor13evil`, que podría registrarse hoy mismo. Los comodines en la
   * parte del propietario son exactamente la clase de atajo que convierte una
   * política de confianza en un agujero.
   */
  repoInmutable?: string;
  /** Ramas desde las que se permite desplegar. */
  ramas: string[];
  /**
   * Entornos de GitHub desde los que se permite desplegar.
   *
   * Esto NO es redundante con `ramas`, y es la trampa más fina de toda la
   * configuración de OIDC: en cuanto un job declara `environment: X`, GitHub
   * **cambia la forma del claim `sub`** del token que emite. Deja de ser
   * `repo:owner/repo:ref:refs/heads/main` y pasa a ser
   * `repo:owner/repo:environment:X`.
   *
   * Si la política de confianza solo contempla la forma con `ref:`, la
   * asunción del rol falla con un "Not authorized to perform sts:AssumeRoleWithWebIdentity"
   * que no dice ni una palabra sobre entornos — y manda a revisar el secreto,
   * que está perfectamente bien.
   */
  entornos: string[];
}

/**
 * El rol que asume GitHub Actions para desplegar. Sin una sola clave estática.
 *
 * Es la respuesta a OWASP A08 y la deuda que quedaba pendiente en
 * `03-nfr/seguridad.md`. La alternativa —guardar un `AWS_ACCESS_KEY_ID` en los
 * secretos del repositorio— es una credencial de larga vida que:
 *  - no caduca sola,
 *  - la ve cualquiera con permiso de escritura sobre los workflows,
 *  - y sobrevive a que la persona que la creó se vaya de la empresa.
 *
 * Con OIDC, GitHub presenta un token firmado por cada ejecución, AWS lo valida
 * contra el proveedor y devuelve credenciales temporales de una hora. No hay
 * nada que rotar porque no hay nada guardado.
 *
 * Se despliega UNA vez, a mano:
 *   npx cdk deploy DocFlow-Cicd
 */
export class CicdStack extends Stack {
  constructor(scope: Construct, id: string, props: CicdStackProps) {
    super(scope, id, props);

    // El proveedor OIDC es único por cuenta. Si ya existe (porque otro
    // proyecto lo creó), se importa en vez de fallar el despliegue.
    const proveedor = new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    /**
     * La condición `sub` es LO ÚNICO que separa "mi repositorio despliega" de
     * "cualquier repositorio de GitHub del mundo despliega en mi cuenta".
     *
     * Se restringe por repositorio Y por rama. Sin la parte de la rama, alguien
     * con permiso para abrir una rama en este repositorio podría desplegar a
     * producción con solo empujar un workflow. Y `aud` se comprueba siempre:
     * omitirla es el error clásico de esta configuración.
     */
    const rol = new iam.Role(this, 'GitHubActionsDeployRole', {
      roleName: 'maya-fact-github-deploy',
      description: 'Asumido por GitHub Actions vía OIDC para desplegar Maya Fact',
      maxSessionDuration: undefined,
      assumedBy: new iam.WebIdentityPrincipal(proveedor.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: {
          // Las dos formas del claim: por rama y por entorno. Siempre acotadas
          // a ESTE repositorio — nunca `repo:*`, que abriría la cuenta a
          // cualquier repositorio de GitHub del mundo.
          // Sin comodines: cada valor es literal. La lista es el producto de
          // {formatos de identidad} x {ramas y entornos permitidos}.
          'token.actions.githubusercontent.com:sub': [props.repo, props.repoInmutable]
            .filter((r): r is string => Boolean(r))
            .flatMap((r) => [
              ...props.ramas.map((rama) => `repo:${r}:ref:refs/heads/${rama}`),
              ...props.entornos.map((entorno) => `repo:${r}:environment:${entorno}`),
            ]),
        },
      }),
    });

    /**
     * Permisos: NO se le da administrador.
     *
     * CDK no despliega con las credenciales del llamante: asume sus propios
     * roles de bootstrap (`cdk-hnb659fds-*`), que ya están acotados. Así que a
     * este rol le basta con poder asumirlos. Es una capa de indirección que
     * mucha gente se salta poniendo `AdministratorAccess`, y que convierte un
     * workflow comprometido en un problema mucho más pequeño.
     */
    rol.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
      }),
    );

    // Publicar la SPA no pasa por CDK: es un `s3 sync` y una invalidación.
    rol.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket', 's3:PutObject', 's3:DeleteObject', 's3:GetObject'],
        resources: [
          `arn:aws:s3:::${this.stackName.toLowerCase()}*`,
          'arn:aws:s3:::docflow-*',
          'arn:aws:s3:::docflow-*/*',
        ],
      }),
    );
    rol.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation', 'cloudfront:ListDistributions'],
        resources: ['*'], // CreateInvalidation no admite permisos por recurso
      }),
    );
    // Leer los outputs del stack para saber a qué bucket y distribución publicar.
    rol.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks'],
        resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/DocFlow-*/*`],
      }),
    );

    new CfnOutput(this, 'RoleArn', {
      value: rol.roleArn,
      description: 'Ponlo en el secreto AWS_DEPLOY_ROLE_ARN del repositorio',
    });
  }
}
