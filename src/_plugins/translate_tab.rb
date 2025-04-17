# frozen_string_literal: true
# encoding: utf-8

module Jekyll
  module LanguagePlugin
    module Tags
      class TranslateDirectTag < Liquid::Tag
        def initialize(tag_name, markup, tokens)
          super
          @markup = markup
        end

        def render(context)
          p = Liquid::Parser.new(@markup)

          # First argument: language code
          lang_expr = Liquid::Expression.parse(exp = p.expression)
          lang = context.evaluate(lang_expr)
          raise Liquid::SyntaxError.new("Invalid language code expression: #{exp}") if lang.nil?

          # Second argument: translation key
          key_expr = Liquid::Expression.parse(exp = p.expression)
          key = context.evaluate(key_expr)
          raise Liquid::SyntaxError.new("Invalid translation key expression: #{exp}") if key.nil?

          # Optional tokens
          tokens = []
          if p.consume?(:colon)
            loop do
              arg = Liquid::Expression.parse(exp = p.expression)
              token = context.evaluate(arg)
              raise Liquid::SyntaxError.new("Invalid parameter expression: #{exp}") if token.nil?
              tokens << token
              break unless p.consume?(:comma)
            end
          end

          # Temporarily override page language
          page = context.registers[:page]
          original_lang = page['language']
          page['language'] = lang

          begin
            Jekyll::LanguagePlugin::LiquidContext.get_language_string(context, key, tokens)
          ensure
            page['language'] = original_lang
          end
        end
      end
    end
  end
end

Liquid::Template.register_tag('td', Jekyll::LanguagePlugin::Tags::TranslateDirectTag)