import { globalAttributes } from './transformer';
import Ast from './ast/index';

import type {
  Node,
  Function,
  Config,
  SchemaAttribute,
  ValidationError,
  Value,
} from './types';

const TypeMappings = {
  String: String,
  Number: Number,
  Array: Array,
  Object: Object,
  Boolean: Boolean,
} as const;

type TypeParam = NonNullable<SchemaAttribute['type']>;

export function validateType(
  type: TypeParam,
  value: Value,
  config: Config
): boolean | ValidationError[] {
  if (!type) return true;

  if (Ast.isFunction(value) && config.validation?.validateFunctions) {
    const schema = config.functions?.[value.name];
    return !schema?.returns
      ? true
      : Array.isArray(schema.returns)
      ? schema.returns.find((t) => t === type) !== undefined
      : schema.returns === type;
  }

  if (Ast.isAst(value)) return true;

  if (Array.isArray(type))
    return type.some((t) => validateType(t, value, config));

  if (typeof type === 'string') type = TypeMappings[type];

  if (typeof type === 'function') {
    const instance: any = new type();
    if (instance.validate) {
      return instance.validate(value, config);
    }
  }

  return value != null && value.constructor === type;
}

function typeToString(type: TypeParam): string {
  if (typeof type === 'string') return type;

  if (Array.isArray(type)) return type.map(typeToString).join(' | ');

  return type.name;
}

function validateFunction(fn: Function, config: Config): ValidationError[] {
  const schema = config.functions?.[fn.name];
  const errors: ValidationError[] = [];

  if (!schema)
    return [
      {
        id: 'function-undefined',
        level: 'critical',
        message: `Undefined function: '${fn.name}'`,
      },
    ];

  if (schema.validate) errors.push(...schema.validate(fn, config));

  if (schema.parameters) {
    for (const [key, value] of Object.entries(fn.parameters)) {
      const param = schema.parameters?.[key];

      if (!param) {
        errors.push({
          id: 'parameter-undefined',
          level: 'error',
          message: `Invalid parameter: '${key}'`,
        });

        continue;
      }

      if (Ast.isAst(value) && !Ast.isFunction(value)) continue;

      if (param.type) {
        const valid = validateType(param.type, value, config);
        if (valid === false) {
          errors.push({
            id: 'parameter-type-invalid',
            level: 'error',
            message: `Parameter '${key}' of '${
              fn.name
            }' must be type of '${typeToString(param.type)}'`,
          });
        } else if (Array.isArray(valid)) {
          errors.push(...valid);
        }
      }
    }
  }

  for (const [key, { required }] of Object.entries(schema.parameters ?? {}))
    if (required && fn.parameters[key] === undefined)
      errors.push({
        id: 'parameter-missing-required',
        level: 'error',
        message: `Missing required parameter: '${key}'`,
      });

  return errors;
}

export default function validate(node: Node, config: Config) {
  const schema = node.findSchema(config);
  const errors: ValidationError[] = [...(node.errors || [])];

  if (!schema) {
    errors.push({
      id: node.tag ? 'tag-undefined' : 'node-undefined',
      level: 'critical',
      message: node.tag
        ? `Undefined tag: '${node.tag}'`
        : `Undefined node: '${node.type}'`,
    });

    return errors;
  }

  if (schema.selfClosing && node.children.length > 0)
    errors.push({
      id: 'tag-selfclosing-has-children',
      level: 'critical',
      message: `'${node.tag}' tag should be self-closing`,
    });

  const attributes = {
    ...globalAttributes,
    ...schema.attributes,
  };

  if (schema.validate) errors.push(...schema.validate(node, config));

  for (let [key, value] of Object.entries(node.attributes)) {
    const attrib = attributes[key];

    if (!attrib) {
      errors.push({
        id: 'attribute-undefined',
        level: 'error',
        message: `Invalid attribute: '${key}'`,
      });

      continue;
    }

    let { type, matches, errorLevel } = attrib;

    if (Ast.isAst(value)) {
      if (Ast.isFunction(value) && config.validation?.validateFunctions)
        errors.push(...validateFunction(value, config));
      else if (Ast.isVariable(value) && config.variables) {
        let missing = false;
        let variables = config.variables;

        for (const key of value.path) {
          if (!Object.prototype.hasOwnProperty.call(variables, key)) {
            missing = true;
            break;
          }
          variables = variables[key];
        }

        if (missing) {
          errors.push({
            id: 'variable-undefined',
            level: 'error',
            message: `Undefined variable: '${value.path.join('.')}'`,
          });
        }
      } else continue;
    }

    value = value as string;
    if (key === 'id' && value.match(/^[0-9]/))
      errors.push({
        id: 'attribute-value-invalid',
        level: 'error',
        message: 'The id attribute must not start with a number',
      });

    if (type) {
      const valid = validateType(type, value, config);
      if (valid === false) {
        errors.push({
          id: 'attribute-type-invalid',
          level: errorLevel || 'error',
          message: `Attribute '${key}' must be type of '${typeToString(type)}'`,
        });
      }
      if (Array.isArray(valid)) {
        errors.push(...valid);
      }
    }

    if (typeof matches === 'function') matches = matches(config);

    if (Array.isArray(matches) && !matches.includes(value))
      errors.push({
        id: 'attribute-value-invalid',
        level: errorLevel || 'error',
        message: `Attribute '${key}' must match one of ${JSON.stringify(
          matches
        )}`,
      });

    if (matches instanceof RegExp && !matches.test(value))
      errors.push({
        id: 'attribute-value-invalid',
        level: errorLevel || 'error',
        message: `Attribute '${key}' must match ${matches}`,
      });
  }

  for (const [key, { required }] of Object.entries(attributes))
    if (required && node.attributes[key] === undefined)
      errors.push({
        id: 'attribute-missing-required',
        level: 'error',
        message: `Missing required attribute: '${key}'`,
      });

  for (const { type } of node.children) {
    if (schema.children && type !== 'error' && !schema.children.includes(type))
      errors.push({
        id: 'child-invalid',
        level: 'warning',
        message: `Can't nest '${type}' in '${node.tag || node.type}'`,
      });
  }

  return errors;
}
