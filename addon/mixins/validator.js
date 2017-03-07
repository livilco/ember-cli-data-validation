import Ember from 'ember';
import ValidationError from '../error';
import defaultMessages from '../messages';
import { attrName } from '../utils';

function getOwner(obj) {
	if(Ember.canInvoke(Ember, 'getOwner')) {
		return Ember.getOwner(obj);
	} else {
		return obj.container;
	}
}

export function createValidationError(model) {
	const messageResolver = lookupMessageResolver(getOwner(model));
	const errors = model.get('errors');
	let message = messageResolver.resolveMessage('error');

	if(Ember.isEmpty(message)) {
		message = Ember.get(defaultMessages, 'error');
	}

	return new ValidationError(message, errors);
}

function lookupMessageResolver(container) {
	return container.lookup('resolver:validation-message') ||
		container.lookup('ember-cli-data-validation@resolver:validation-message');
}

function lookupValidtorFactory(container, key) {
	let lookupFactory;

	if(Ember.canInvoke(container, '_lookupFactory')) {
		lookupFactory = container._lookupFactory;
	} else {
		lookupFactory = container.lookupFactory;
	}

	return lookupFactory.call(container, `validator:${key}`) ||
		lookupFactory.call(container, `ember-cli-data-validation@validator:${key}`);
}

function lookupValidator(container, obj) {
	const typeKey = obj.type;
	const validatorClass =lookupValidtorFactory(container, typeKey);

	Ember.assert('Could not find Validator `' + typeKey + '`.', typeof validatorClass === 'function');

	const messageResolver = lookupMessageResolver(container);
	let value = obj.value;

	if (typeof value !== 'object') {
		value = {};

		value[obj.type] = obj.value;
	}

	Ember.merge(value, {
		attribute: obj.attribute,
		messageResolver: messageResolver
	});

	validatorClass.typeKey = Ember.String.camelize(typeKey);

	return validatorClass.create(value);
}

/**
 * Validator Mixin to be used on a DS.Model.
 *
 * Exposes the validation functionality for Ember Models.
 *
 * @class ValidatorMixin
 */
export default Ember.Mixin.create({

	/**
	 * Resolves the List of Validators for a given attribute.
	 *
	 * @method validatorsFor
	 * @param  {Attribute}  attribute
	 * @return {Validator}
	 */
	validatorsFor: function(attribute) {
		const meta = attribute.options;
		let validations = Ember.get(meta, 'validation');

		if (Ember.isEmpty(validations)) {
			return [];
		}

		if (!Ember.isArray(validations)) {
			validations = [validations];
		}

		const validators = [];

		validations.forEach((validation) => {
			const keys = Object.keys(validation);

			keys.forEach((name) => {
				validators.push({
					type: name,
					value: validation[name],
					attribute: attribute
				});
			});
		});

		return validators.map((validator) => {
			return lookupValidator(getOwner(this), validator);
		});
	},

	/**
	 * Validate a single Attribute.
	 *
	 * If the Attribute has defined validation, it would try to resolve
	 * the the required Validators and run validation.
	 *
	 * For each failed validation, error message is added to the Errors
	 * object for it's attribute name.
	 *
	 * @method _validateAttribute
	 * @param  {Attribute} attribute
	 * @private
	 */
	_validateAttribute: function(attribute) {
		const validators = this.validatorsFor(attribute);
		const name = attrName(attribute);

		// Assign the Model name to the Attribute
		attribute.parentTypeKey = this.constructor.modelName ||
			this.constructor.typeKey;

		validators.forEach((validator) => {
			const result = validator.validate(name, this.get(name), attribute, this);
			this._addError(name, result);
		});
	},

	_addError: function(name, result) {
		const errors = this.get('errors');

		if (typeof result === 'string') {
			if(Ember.canInvoke(errors, '_add')) {
				errors._add(name, result);
			} else {
				errors.add(name, result);
			}
		}
	},

	/**
	 * Validates the Model.
	 *
	 * If the Model is valid, this method would return `true`.
	 *
	 * If the validation fails, Model Errors would be populated
	 * by validation errors and it would transition into an invalid
	 * state.
	 *
	 * @method validate
	 * @return {Boolean}
	 */
	validate: function({willCommit=true}={}) {
		let errors = this.get('errors');

		if (!this.get('isValid')) {
			this.send('becameValid');
			errors._clear();
		}

		// Do not validate the records which are deleted
		if (this.get('isDeleted')) {
			return true;
		}

		if (willCommit) {
			// Move the Model into `inFlight` state
			this.send('willCommit');
		}

		this.eachAttribute((key, attribute) => {
			Ember.run(this, '_validateAttribute', attribute);
		});

		this.eachRelationship((key, relationship) => {
			Ember.run(this, '_validateAttribute', relationship);
		});

		const isValid = Ember.get(errors, 'isEmpty');

		if (!isValid) {
			// ensure the model is dirty - required if you have bypassed validation before and so the record in the root.loaded.saved state and now you would like to validate
			this.send('becomeDirty');

			// From Ember Data 2.3.* it is required to manually trigger
			// `bacameInvalid` event in order to change the model state.
			errors.trigger('becameInvalid');
		}

		return isValid;
	},

	save: function({validate=true}={}) {
		if (!validate) {
			return this._super();
		}

		if (this.validate()) {
			return this._super();
		}

		return Ember.RSVP.reject(createValidationError(this));
	}
});
