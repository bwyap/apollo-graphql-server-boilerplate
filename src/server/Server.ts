import fs from 'fs';
import https from 'https';
import express from 'express';
import compression from 'compression';
import cors from 'cors';
import morgan from 'morgan';
import enforce from 'express-sslify';
import { parse } from 'graphql';
import { collectFields } from '../graphql/utils/graphqlOperationUtils';
import { EnhancedApolloServer } from './EnhancedApolloServer';

import { Config } from 'apollo-server-express';

import generateGraphQLDefinitions from '../graphql';
import createCostAnalyzerOptions from '../graphql/cost';

import configureEnvironment from '../environment/configureEnvironment';

import { ServerConfiguration } from './types';
import { EServiceName } from '../services/service/enums';
import createLoggingService, {
  LoggerLevelOutputFn,
  LoggingService,
  LogLevel,
  createDefaultLogger,
  LogTopic,
} from '../services/LoggingService';
import ServiceLibrary, { IServiceLibrary } from '../services/ServiceLibrary';
import { IContextCreatorService } from '../services/ContextCreatorService';

import initialiseBasicServices from './basicServices';

export class Server {
  private config: ServerConfiguration;
  private log: LoggerLevelOutputFn;
  private serviceLibrary: IServiceLibrary;

  private server;
  private portConfig: { port: number };
  private useSSL: boolean;

  constructor(config: ServerConfiguration) {
    this.config = config;
    this.log = LoggingService.void;
  }

  /**
   * Initialise all services for the server.
   */
  public initialiseServices = async () => {
    // Configure environment
    await configureEnvironment();

    // Initialise logging service
    const LOCAL = process.env.NODE_ENV === 'local';
    const loggingService = await createLoggingService(
      this.config.logger,
      LOCAL,
    );
    loggingService.addOutput('console', createDefaultLogger());
    this.log = loggingService.createLogger(LogTopic.SERVER);

    // Initialise service library
    const serviceLibrary = new ServiceLibrary();
    await serviceLibrary.init({
      log: loggingService.createLogger(LogTopic.SERVICE),
    });
    this.serviceLibrary = serviceLibrary;

    // Initialise basic services
    this.log(LogLevel.SILLY)(`Initalising services...`);
    await initialiseBasicServices(
      this.config,
      loggingService,
      this.serviceLibrary,
    );

    // TODO: add more services to be initialised here if required

    this.log(LogLevel.DEBUG)(`Services initialised.`);
  };

  /**
   * Configure the server with services and settings so that it is ready to start.
   */
  public configureServer = async () => {
    this.log(LogLevel.SILLY)(`Configuring server...`);
    const CERT_NAME = 'localhost';
    const PRODUCTION = process.env.NODE_ENV === 'production';
    const LOCAL = process.env.NODE_ENV === 'local';

    // =======================
    //  GraphQL configuration
    // =======================

    const contextCreator: IContextCreatorService = this.serviceLibrary.getService<
      IContextCreatorService
    >(EServiceName.ContextCreatorService);

    const loggingService = this.serviceLibrary.getService<LoggingService>(
      EServiceName.LoggingService,
    );

    // Apollo server configuration
    const apolloServerOptions: Config = {
      ...generateGraphQLDefinitions(process.env.NODE_ENV),
      introspection: !PRODUCTION,
      playground: !PRODUCTION,
      engine: {
        apiKey: process.env.ENGINE_API_KEY,
      },
      context: async ({ req, connection }) => {
        let auth: string = null;
        let query = null;

        if (!connection) {
          // Normal request
          auth = req.headers.authorization;
          query = parse(req.body.query).definitions[0];
        } else {
          // If a connection exists, request was a subscription
          auth = connection.context.authorization;
          query = parse(connection.query).definitions[0];
        }

        // Get the requested root fields names
        const fields = collectFields(query);

        // Generate context based on authorization and requested fields
        return contextCreator.createContext(auth, fields);
      },
      subscriptions: {
        onConnect: async (connectionParams: any) => {
          // On connection, pass authorization header into connection
          // context to be handled by the context function.
          return { authorization: connectionParams.authorization };
        },
      },
    };

    /**
     * FIXME: using the EnhancedApolloServer because it provides
     * a custom extension that provides a workaround for a plugin
     * issue with graphql-cost-anlysis.
     */
    // Create Apollo server with GraphQL typeDefs and resolvers
    const apollo = new EnhancedApolloServer(
      apolloServerOptions,
      createCostAnalyzerOptions(
        loggingService.createLogger(LogTopic.GRAPHQLCOST),
      ),
    );

    // =======================
    //  Express configuration
    // =======================

    // Create Express app
    const app = express();

    // Set default port
    this.portConfig = { port: parseInt(process.env.PORT, 10) || 4000 };

    // List of CORS allowed origins
    const subdomainsRegexPartial = this.config.subdomains
      .map(s => `${s}\.`)
      .join('|');

    const allowedOrigins = [
      // This allows the root domain and all subdomains with AND without `dev` and `qat` prefixes.
      new RegExp(
        `https:\/\/(dev\.|qat\.){0,1}(${subdomainsRegexPartial}){0,1}${
          process.env.DOMAIN_REGEX
        }`,
      ),
    ];

    // Allow localhost on non-production environments
    if (!PRODUCTION) allowedOrigins.push(/https?:\/\/localhost\:[0-9]{4}/);

    // Set `trustProtoHeader` for Heroku. See https://www.npmjs.com/package/express-sslify
    if (!LOCAL) app.use(enforce.HTTPS({ trustProtoHeader: true }));

    // Serve static files from public folder
    app.use(express.static('public'));

    // Apply middleware GraphQL server
    apollo.applyMiddleware({ app });

    // Configure Express app
    app.use(cors({ origin: allowedOrigins }));
    app.disable('x-powered-by');
    app.use(compression());
    app.use(
      morgan(
        ':method :url HTTP/:http-version - :status :response-time ms :res[content-length]',
        {
          stream: {
            write: msg => this.log(LogLevel.DEBUG)(msg.replace('\n', '')),
          },
        },
      ),
    );

    // Serve static files from public folder
    app.use(express.static('public'));

    // Configure SSL if available on localhost
    if (
      LOCAL &&
      fs.existsSync(`./certs/${CERT_NAME}.crt`) &&
      fs.existsSync(`./certs/${CERT_NAME}.key`)
    ) {
      this.server = https.createServer(
        {
          key: fs.readFileSync(`./certs/${CERT_NAME}.key`),
          cert: fs.readFileSync(`./certs/${CERT_NAME}.crt`),
        },
        app,
      );
      this.useSSL = true;
      this.portConfig = { port: 443 };
      this.log(LogLevel.SILLY)(`Local server configured with custom SSL.`);
    } else {
      this.server = app;
    }

    // Add GraphQL subscription capability
    apollo.installSubscriptionHandlers(this.server);

    this.log(LogLevel.DEBUG)(`Server configuration complete.`);
  };

  /**
   * Start the server.
   * Remember to use `initaliseServices()` and `configureServer()` first.
   */
  public start = () => {
    const LOCAL = process.env.NODE_ENV === 'local';

    this.server.listen(this.portConfig, () => {
      this.log(LogLevel.INFO)(
        `SERVER READY in ${process.env.NODE_ENV.toUpperCase()} environment (port=${
          this.portConfig.port
        })`,
      );
      if (LOCAL) {
        if (this.useSSL) {
          this.log(LogLevel.DEBUG)(`SERVER READY at https://localhost`);
        } else {
          this.log(LogLevel.DEBUG)(
            `SERVER READY at http://localhost:${this.portConfig.port}`,
          );
          this.log(LogLevel.DEBUG)(
            `WARNING: Configure a HTTPS server for secure connections.`,
          );
        }
      }
    });
  };
}
